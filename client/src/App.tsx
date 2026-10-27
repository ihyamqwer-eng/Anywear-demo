import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CircleStop,
  Compass,
  Download,
  Expand,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Gauge,
  ImagePlus,
  LoaderCircle,
  Minimize2,
  Monitor,
  PictureInPicture2,
  RefreshCw,
  Shirt,
  Sparkles,
  Smartphone,
  SlidersHorizontal,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { ApiError, createSession, fetchGarmentGroups, imageToBase64, importGarmentGroup, stopSession } from './api';
import AppVersion from './AppVersion';
import { getSelectedProviderKeySelection } from './provider-key-selection';
import { downloadDiagnosticLogs, getBrowserDiagnosticContext, getDiagnosticLogs, logDiagnostic, subscribeDiagnosticLogs } from './diagnostics';
import { RealtimeConnection, type RealtimeMediaStats } from './realtime';
import { initialWatermarkStatus, RemoteWatermarkProcessor, watermarkStateLabels, type WatermarkStatus } from './watermark';
import type { Garment, GarmentGroup, ProviderMessage, SessionState } from './types';

type ViewStatus = 'idle' | 'starting' | 'live' | 'switching' | 'error' | 'stopped';

const statusLabels: Record<ViewStatus, string> = {
  idle: '准备开始',
  starting: '连接中',
  live: '实时试衣',
  switching: '换装中',
  error: '连接异常',
  stopped: '已停止',
};

const stateLabels: Record<SessionState, string> = {
  idle: '待机',
  camera_ready: '摄像头就绪',
  signaling: '建立连接',
  connected: '已连接',
  generating: '生成中',
  switching: '换装中',
  stopping: '正在停止',
  error: '异常',
};

const panelPreferenceKeys = {
  capture: 'anywear-capture-panel-collapsed',
  diagnostics: 'anywear-diagnostics-panel-collapsed',
  garments: 'anywear-garment-panel-collapsed-v2',
} as const;

function readCollapsedPreference(key: string) {
  try {
    return window.localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

function toggleCollapsedPreference(key: string, setCollapsed: Dispatch<SetStateAction<boolean>>) {
  setCollapsed((collapsed) => {
    const next = !collapsed;
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // The control remains usable when browser storage is unavailable.
    }
    return next;
  });
}

const captureProfiles = [
  { id: '1080p', label: '1920 × 1080', width: 1920, height: 1080 },
  { id: '720p', label: '1280 × 720', width: 1280, height: 720 },
  { id: '540p', label: '960 × 540', width: 960, height: 540 },
] as const;

const frameRateOptions = [15, 20, 30] as const;
type CaptureProfileId = typeof captureProfiles[number]['id'];
type CameraDevice = { deviceId: string; label: string };
const maxUploadBytes = 10 * 1024 * 1024;
const maxGroupImageCount = 200;
const maxGroupUploadBytes = 200 * 1024 * 1024;
const garmentsPerPage = 8;
const uploadedGroupId = 'user-garment-uploads';
const cameraPreferenceKey = 'anywear-camera-device-id';
const watermarkPreferenceKey = 'anywear-local-watermark-processing';

function readWatermarkPreference(): boolean {
  try {
    return window.localStorage.getItem(watermarkPreferenceKey) !== 'false';
  } catch {
    return true;
  }
}

function formatBitrate(value: number | null): string {
  if (value === null) return '--';
  return `${(value / 1_000_000).toFixed(1)} Mbps`;
}

function formatDimension(width: number | null, height: number | null): string {
  return width && height ? `${width} × ${height}` : '--';
}

function formatFps(value: number | null): string {
  return value === null ? '--' : `${value.toFixed(1)} FPS`;
}

function formatGarmentLabel(index: number): string {
  return String(index % 1000).padStart(3, '0');
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const maxEncodedDataUrlLength = Math.ceil(maxUploadBytes / 3) * 4 + 64;
  if (dataUrl.length > maxEncodedDataUrlLength) throw new Error('衣服图片不能超过 10 MB');

  const match = /^data:image\/(jpeg|png|webp);base64,([a-z\d+/]*={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error('网页图片必须是 JPG、PNG 或 WebP 格式');

  const base64 = match[2];
  const paddingBytes = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedSize = Math.floor(base64.length * 3 / 4) - paddingBytes;
  if (decodedSize > maxUploadBytes) throw new Error('衣服图片不能超过 10 MB');

  const type = `image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()}`;
  const bytes = Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
  const safeName = name.replace(/[\\/:\0-\x1f]/g, '_').slice(0, 120) || '网页服装';
  return new File([bytes], safeName, { type });
}

function App() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const garmentGridRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const processedVideoRef = useRef<HTMLVideoElement>(null);
  const processedCanvasRef = useRef<HTMLCanvasElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const watermarkProcessorRef = useRef<RemoteWatermarkProcessor | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const pendingGarmentIdRef = useRef<string | null>(null);
  const queuedGarmentRef = useRef<Garment | null>(null);
  const garmentTimeoutRef = useRef<number | undefined>(undefined);
  const garmentsRef = useRef<Garment[]>([]);
  const garmentGroupsRef = useRef<GarmentGroup[]>([]);
  const cameraRequestRef = useRef(0);
  const cameraOpenPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [garmentGroups, setGarmentGroups] = useState<GarmentGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupPage, setGroupPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingGarmentId, setPendingGarmentId] = useState<string | null>(null);
  const [queuedGarmentId, setQueuedGarmentId] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewStatus>('idle');
  const [cameraPreviewState, setCameraPreviewState] = useState<'closed' | 'opening' | 'open'>('closed');
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [message, setMessage] = useState('');
  const [usageSeconds, setUsageSeconds] = useState(0);
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteStreamGeneration, setRemoteStreamGeneration] = useState(0);
  const [watermarkEnabled, setWatermarkEnabled] = useState(readWatermarkPreference);
  const [watermarkHasFrame, setWatermarkHasFrame] = useState(false);
  const [watermarkStatus, setWatermarkStatus] = useState<WatermarkStatus>(() => initialWatermarkStatus());
  const [viewOrientation, setViewOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [flipHorizontal, setFlipHorizontal] = useState(true);
  const [flipVertical, setFlipVertical] = useState(false);
  const [cameraSize, setCameraSize] = useState<{ width: number; height: number } | null>(null);
  const [remoteSize, setRemoteSize] = useState<{ width: number; height: number } | null>(null);
  const [mediaStats, setMediaStats] = useState<RealtimeMediaStats | null>(null);
  const diagnosticLogs = useSyncExternalStore(subscribeDiagnosticLogs, getDiagnosticLogs, getDiagnosticLogs);
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [cameraDeviceId, setCameraDeviceId] = useState(() => {
    try {
      return window.localStorage.getItem(cameraPreferenceKey) ?? '';
    } catch {
      return '';
    }
  });
  const [captureProfileId, setCaptureProfileId] = useState<CaptureProfileId>('1080p');
  const [frameRate, setFrameRate] = useState<number>(30);
  const [isSavingGarments, setIsSavingGarments] = useState(false);
  const captureProfile = captureProfiles.find((profile) => profile.id === captureProfileId) ?? captureProfiles[0];
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [capturePanelCollapsed, setCapturePanelCollapsed] = useState(() => readCollapsedPreference(panelPreferenceKeys.capture));
  const [diagnosticsPanelCollapsed, setDiagnosticsPanelCollapsed] = useState(() => readCollapsedPreference(panelPreferenceKeys.diagnostics));
  const [garmentPanelCollapsed, setGarmentPanelCollapsed] = useState(() => readCollapsedPreference(panelPreferenceKeys.garments));
  const isCompactWindow = new URLSearchParams(window.location.search).has('compact');
  const showError = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    logDiagnostic('error', 'ui.error', { name: error instanceof Error ? error.name : typeof error, message: text });
    setMessage(text);
    setStatus('error');
    setSessionState('error');
  }, []);

  const refreshCameraDevices = useCallback(async () => {
    if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
      setCameraDevices([]);
      return;
    }
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'videoinput' && device.deviceId)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `摄像头 ${index + 1}`,
        }));
      setCameraDevices(devices);
    } catch (error) {
      logDiagnostic('warn', 'camera.enumeration.failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
    }
  }, []);

  const releaseMedia = useCallback(() => {
    cameraRequestRef.current += 1;
    cameraOpenPromiseRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    watermarkProcessorRef.current?.stop();
    watermarkProcessorRef.current = null;
    if (processedVideoRef.current) processedVideoRef.current.srcObject = null;
    setCameraPreviewState('closed');
    setRemoteReady(false);
    setWatermarkHasFrame(false);
    setWatermarkStatus(initialWatermarkStatus());
    setCameraSize(null);
    setRemoteSize(null);
    setMediaStats(null);
  }, []);

  const openCameraPreview = useCallback(async () => {
    const activeStream = localStreamRef.current;
    if (activeStream?.getVideoTracks().some((track) => track.readyState === 'live')) return activeStream;
    if (cameraOpenPromiseRef.current) return cameraOpenPromiseRef.current;

    const requestId = ++cameraRequestRef.current;
    setCameraPreviewState('opening');
    setMessage('');
    const opening = (async () => {
      logDiagnostic('info', 'camera.preview.requested', {
        ...getBrowserDiagnosticContext(),
        captureProfile: captureProfile.id,
        frameRate,
        cameraSelection: cameraDeviceId ? 'specific' : 'default',
      });
      if (!window.isSecureContext) {
        throw new Error('当前页面不在安全上下文中，浏览器不会开放摄像头。请使用 HTTPS 或本机地址访问。');
      }
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        throw new Error('当前浏览器未提供摄像头接口，请使用最新版 Chrome 并确认摄像头权限。');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : {}),
          width: { ideal: captureProfile.width, max: captureProfile.width },
          height: { ideal: captureProfile.height, max: captureProfile.height },
          frameRate: { ideal: frameRate, max: frameRate },
        },
        audio: false,
      });
      if (requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('摄像头预览已取消');
      }
      localStreamRef.current = stream;
      void refreshCameraDevices();
      const cameraSettings = stream.getVideoTracks()[0]?.getSettings();
      logDiagnostic('info', 'camera.preview.opened', {
        width: cameraSettings?.width ?? null,
        height: cameraSettings?.height ?? null,
        frameRate: cameraSettings?.frameRate ?? null,
        facingMode: cameraSettings?.facingMode ?? null,
        selectedDevice: cameraDeviceId ? 'specific' : 'default',
      });
      if (cameraSettings?.width && cameraSettings.height) setCameraSize({ width: cameraSettings.width, height: cameraSettings.height });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play().catch(() => undefined);
      }
      setCameraPreviewState('open');
      setSessionState('camera_ready');
      return stream;
    })();
    cameraOpenPromiseRef.current = opening;
    try {
      return await opening;
    } catch (error) {
      if (requestId === cameraRequestRef.current) {
        setCameraPreviewState('closed');
        setMessage(error instanceof Error ? error.message : String(error));
        logDiagnostic('error', 'camera.preview.failed', {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (cameraOpenPromiseRef.current === opening) cameraOpenPromiseRef.current = null;
    }
  }, [cameraDeviceId, captureProfile, frameRate, refreshCameraDevices]);

  const closeCameraPreview = useCallback(() => {
    if (sessionIdRef.current) return;
    lifecycleRef.current += 1;
    logDiagnostic('info', 'camera.preview.closed', {});
    releaseMedia();
    setSessionState('idle');
    setMessage('');
  }, [releaseMedia]);

  const toggleCameraPreview = () => {
    if (cameraPreviewState === 'open') closeCameraPreview();
    else void openCameraPreview().catch(() => undefined);
  };

  const teardown = useCallback(async (finalStatus: ViewStatus) => {
    const lifecycle = ++lifecycleRef.current;
    const sessionId = sessionIdRef.current;
    window.clearTimeout(garmentTimeoutRef.current);
    garmentTimeoutRef.current = undefined;
    pendingGarmentIdRef.current = null;
    queuedGarmentRef.current = null;
    setPendingGarmentId(null);
    setQueuedGarmentId(null);
    connectionRef.current?.close();
    connectionRef.current = null;
    sessionIdRef.current = null;
    releaseMedia();
    if (sessionId) await stopSession(sessionId).catch(() => undefined);
    if (lifecycle !== lifecycleRef.current) return;
    setUsageSeconds(0);
    setSessionState(finalStatus === 'error' ? 'error' : 'idle');
    setStatus(finalStatus);
    if (finalStatus !== 'error') setMessage('');
  }, [releaseMedia]);

  const stop = useCallback(async (_reason = '用户停止') => {
    await teardown('stopped');
  }, [teardown]);

  const failSession = useCallback(async (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    setMessage(text);
    await teardown('error');
  }, [teardown]);

  const selectGarment = useCallback(async (garment: Garment) => {
    if (pendingGarmentIdRef.current) {
      if (garment.id === pendingGarmentIdRef.current) {
        queuedGarmentRef.current = null;
        setQueuedGarmentId(null);
      } else {
        queuedGarmentRef.current = garment;
        setQueuedGarmentId(garment.id);
      }
      return;
    }
    const connection = connectionRef.current;
    if (!connection) {
      selectedIdRef.current = garment.id;
      setSelectedId(garment.id);
      return;
    }
    pendingGarmentIdRef.current = garment.id;
    setPendingGarmentId(garment.id);
    setMessage('');
    setStatus((current) => current === 'live' ? 'switching' : current);
    setSessionState((current) => current === 'connected' || current === 'generating' ? 'switching' : current);
    try {
      const imageData = await imageToBase64(garment.image);
      if (connectionRef.current !== connection || pendingGarmentIdRef.current !== garment.id) return;
      const sent = connection.send({
        type: 'set_image',
        image_data: imageData,
        prompt: garment.prompt,
        enhance_prompt: false,
      }, () => {
        if (connectionRef.current !== connection || pendingGarmentIdRef.current !== garment.id) return;
        window.clearTimeout(garmentTimeoutRef.current);
        garmentTimeoutRef.current = window.setTimeout(() => {
          if (pendingGarmentIdRef.current !== garment.id) return;
          void failSession(new Error('服装处理超时，实时会话已停止，请重新连接'));
        }, 30_000);
      });
      if (!sent) throw new Error('换装信令连接已关闭，请重新连接');
    } catch (error) {
      if (connectionRef.current !== connection) return;
      pendingGarmentIdRef.current = null;
      setPendingGarmentId(null);
      setMessage(error instanceof Error ? error.message : String(error));
      if (!queuedGarmentRef.current) {
        setStatus((current) => current === 'switching' ? 'live' : current);
        setSessionState((current) => current === 'switching' ? 'connected' : current);
      }
    }
  }, [failSession]);

  const publishImportedGroup = useCallback((group: GarmentGroup) => {
    const currentGroups = garmentGroupsRef.current;
    const groupIndex = currentGroups.findIndex((item) => item.id === group.id);
    const nextGroups = groupIndex < 0
      ? [...currentGroups, group]
      : currentGroups.map((item) => item.id === group.id ? group : item);
    const nextGarments = nextGroups.flatMap((item) => item.garments);
    garmentGroupsRef.current = nextGroups;
    garmentsRef.current = nextGarments;
    setGarmentGroups(nextGroups);
    setGarments(nextGarments);
    setActiveGroupId(group.id);
    setGroupPage(0);
  }, []);

  const addUploadedGarment = useCallback(async (file: File) => {
    if (file.size > maxUploadBytes) {
      setMessage('衣服图片不能超过 10 MB');
      return;
    }
    setIsSavingGarments(true);
    setMessage('正在保存服装图片…');
    try {
      const existingIds = new Set(garmentGroupsRef.current.find((item) => item.id === uploadedGroupId)?.garments.map((item) => item.id) ?? []);
      const group = await importGarmentGroup('我的上传', [file], uploadedGroupId);
      publishImportedGroup(group);
      const garment = group.garments.find((item) => !existingIds.has(item.id)) ?? group.garments.at(-1);
      if (garment) {
        selectedIdRef.current = garment.id;
        setSelectedId(garment.id);
        if (connectionRef.current) await selectGarment(garment);
      }
      setMessage('服装已保存到本机，之后无需重新上传');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingGarments(false);
    }
  }, [publishImportedGroup, selectGarment]);

  const handleUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessage('请选择 JPG、PNG 或 WebP 图片');
      return;
    }
    if (file.size > maxUploadBytes) {
      setMessage('衣服图片不能超过 10 MB');
      return;
    }
    try {
      await addUploadedGarment(file);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [addUploadedGarment]);

  const handleDirectoryImport = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    const imageFiles = files.filter((file) => /\.(jpe?g|png|webp)$/i.test(file.name)
      || ['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
    const supportedFiles = imageFiles.filter((file) => file.size <= maxUploadBytes);
    if (supportedFiles.length === 0) {
      setMessage(imageFiles.length > 0 ? '衣服图片不能超过 10 MB' : '所选目录中没有 JPG、PNG 或 WebP 图片');
      return;
    }
    const totalBytes = supportedFiles.reduce((total, file) => total + file.size, 0);
    if (supportedFiles.length > maxGroupImageCount || totalBytes > maxGroupUploadBytes) {
      setMessage('单个图组最多保存 200 张图片，总大小不超过 200 MB');
      return;
    }

    const relativePath = supportedFiles[0].webkitRelativePath;
    const directoryName = (relativePath.split('/')[0] || '本地服装目录').slice(0, 32);
    setIsSavingGarments(true);
    setMessage('正在保存图组到本机…');
    try {
      const group = await importGarmentGroup(directoryName, supportedFiles);
      publishImportedGroup(group);
      setMessage(`已保存图组「${group.name}」，下次打开仍可使用`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingGarments(false);
    }
    const rejectedCount = files.length - supportedFiles.length;
    if (rejectedCount > 0) setMessage((current) => `${current}；跳过 ${rejectedCount} 个不支持或超过 10 MB 的文件`);
  }, [publishImportedGroup]);

  const start = useCallback(async () => {
    if (status === 'starting' || status === 'live' || status === 'switching') return;
    const lifecycle = ++lifecycleRef.current;
    setStatus('starting');
    setMessage('');
    setSessionState('camera_ready');
    let ownedSessionId: string | null = null;
    let ownedConnection: RealtimeConnection | null = null;
    try {
      logDiagnostic('info', 'session.start.requested', {
        ...getBrowserDiagnosticContext(),
        captureProfile: captureProfile.id,
        frameRate,
        cameraSelection: cameraDeviceId ? 'specific' : 'default',
      });
      const stream = localStreamRef.current ?? await openCameraPreview();
      if (lifecycle !== lifecycleRef.current) return;
      const session = await createSession(getSelectedProviderKeySelection());
      ownedSessionId = session.sessionId;
      if (lifecycle !== lifecycleRef.current) {
        await stopSession(ownedSessionId).catch(() => undefined);
        return;
      }
      sessionIdRef.current = ownedSessionId;
      logDiagnostic('info', 'session.created', { sessionId: ownedSessionId.slice(0, 8), expiresAt: session.expiresAt });
      const connection = new RealtimeConnection({
        session,
        localStream: stream,
        onRemoteStream: (remoteStream) => {
          if (sessionIdRef.current !== session.sessionId) return;
          logDiagnostic('info', 'media.remote-stream', { tracks: remoteStream.getTracks().map((track) => track.kind) });
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            void remoteVideoRef.current.play().catch(() => undefined);
          }
          setWatermarkHasFrame(false);
          setWatermarkStatus(initialWatermarkStatus());
          setRemoteStreamGeneration((generation) => generation + 1);
          setStatus('live');
        },
        onMessage: (providerMessage: ProviderMessage) => {
          if (sessionIdRef.current !== session.sessionId) return;
          if (['generation_started', 'generation_ended', 'set_image_ack', 'error'].includes(providerMessage.type)) {
            logDiagnostic(providerMessage.type === 'error' ? 'error' : 'info', 'provider.message', { type: providerMessage.type });
          }
          if (providerMessage.type === 'generation_started') {
            setStatus('live');
            setSessionState('generating');
          }
          if (providerMessage.type === 'generation_tick' && typeof providerMessage.seconds === 'number') {
            setUsageSeconds(providerMessage.seconds);
          }
          if (providerMessage.type === 'generation_ended') void stop('供应商结束');
          if (providerMessage.type === 'set_image_ack' && pendingGarmentIdRef.current) {
            const pendingId = pendingGarmentIdRef.current;
            window.clearTimeout(garmentTimeoutRef.current);
            garmentTimeoutRef.current = undefined;
            pendingGarmentIdRef.current = null;
            setPendingGarmentId(null);
            if (providerMessage.success !== false) {
              selectedIdRef.current = pendingId;
              setSelectedId(pendingId);
            } else {
              setMessage(providerMessage.error || '服装图片未被接受');
            }
            if (!queuedGarmentRef.current) {
              setStatus((current) => current === 'switching' ? 'live' : current);
              setSessionState((current) => current === 'switching' ? 'connected' : current);
            }
          }
          if (providerMessage.type === 'error') {
            void failSession(new Error(providerMessage.error || '实时试衣请求失败'));
          }
          if (providerMessage.type === 'prompt_ack' && providerMessage.success === false) {
            setMessage(providerMessage.error || '试衣描述未被接受');
          }
        },
        onState: (peerState) => {
          if (sessionIdRef.current !== session.sessionId) return;
          logDiagnostic(peerState === 'failed' ? 'error' : 'info', 'webrtc.connection-state', { state: peerState });
          if (peerState === 'connected') setSessionState('connected');
          if (peerState === 'failed') void failSession(new Error('WebRTC 媒体连接失败'));
        },
        onSignalState: (signalState) => {
          if (signalState !== 'closed' && sessionIdRef.current !== session.sessionId) return;
          logDiagnostic(signalState === 'closed' ? 'warn' : 'info', 'signaling.state', { state: signalState });
          if (signalState === 'open') setSessionState('signaling');
          if (signalState === 'closed' && sessionIdRef.current === session.sessionId) void failSession(new Error('信令连接已关闭'));
        },
        onError: (error) => {
          logDiagnostic('error', 'realtime.error', { name: error.name, message: error.message });
          if (sessionIdRef.current === session.sessionId) void failSession(error);
        },
      });
      ownedConnection = connection;
      connectionRef.current = connection;
      const availableGarments = garmentsRef.current;
      const firstGarment = availableGarments.find((garment) => garment.enabled && garment.id === selectedIdRef.current)
        ?? availableGarments.find((garment) => garment.enabled);
      if (firstGarment) await selectGarment(firstGarment);
    } catch (error) {
      logDiagnostic('error', 'session.start.failed', {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        secureContext: window.isSecureContext,
        mediaDevicesAvailable: typeof navigator.mediaDevices !== 'undefined',
      });
      ownedConnection?.close();
      if (connectionRef.current === ownedConnection) connectionRef.current = null;
      if (ownedSessionId) await stopSession(ownedSessionId).catch(() => undefined);
      if (lifecycle === lifecycleRef.current) {
        releaseMedia();
        if (sessionIdRef.current === ownedSessionId) sessionIdRef.current = null;
        if (error instanceof ApiError && error.code === 'PROVIDER_POOL_CHANGED') {
          window.location.assign(`/cards?selection_reset=1${isCompactWindow ? '&compact=1' : ''}`);
          return;
        }
        showError(error);
      }
    }
  }, [cameraDeviceId, captureProfile, failSession, frameRate, isCompactWindow, openCameraPreview, releaseMedia, selectGarment, showError, status, stop]);

  useEffect(() => {
    const queuedGarment = queuedGarmentRef.current;
    if (pendingGarmentId || !queuedGarmentId || !queuedGarment || !connectionRef.current) return;
    queuedGarmentRef.current = null;
    setQueuedGarmentId(null);
    void selectGarment(queuedGarment);
  }, [pendingGarmentId, queuedGarmentId, selectGarment]);

  useEffect(() => {
    fetchGarmentGroups().then((groups) => {
      garmentGroupsRef.current = groups;
      garmentsRef.current = groups.flatMap((group) => group.garments);
      setGarments(garmentsRef.current);
      setGarmentGroups(groups);
    }).catch(showError);
    return () => {
      void teardown('idle');
    };
  }, [showError, teardown]);

  useEffect(() => {
    const handleDeviceChange = () => void refreshCameraDevices();
    void refreshCameraDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
  }, [refreshCameraDevices]);

  useEffect(() => {
    try {
      window.localStorage.setItem(watermarkPreferenceKey, String(watermarkEnabled));
    } catch {
    }
  }, [watermarkEnabled]);

  useEffect(() => {
    if (!watermarkEnabled) {
      setWatermarkHasFrame(false);
      if (processedVideoRef.current) processedVideoRef.current.srcObject = null;
      setWatermarkStatus(initialWatermarkStatus('disabled'));
      return;
    }
    if (!remoteReady) {
      setWatermarkHasFrame(false);
      setWatermarkStatus(initialWatermarkStatus());
      return;
    }
    if (pendingGarmentId || queuedGarmentId) {
      setWatermarkHasFrame(false);
      setWatermarkStatus({ ...initialWatermarkStatus(), message: '服装切换确认后重新建立处理流' });
      return;
    }

    const video = remoteVideoRef.current;
    const outputVideo = processedVideoRef.current;
    const outputCanvas = processedCanvasRef.current;
    if (!video || !outputVideo || !outputCanvas) return;

    let active = true;
    let outputStream: MediaStream | null = null;
    let frameCallback: number | null = null;
    let animationFrame = 0;
    let lastStatusState: WatermarkStatus['state'] | null = null;
    setWatermarkHasFrame(false);
    setWatermarkStatus(initialWatermarkStatus());
    const processor = new RemoteWatermarkProcessor(video, outputCanvas, {
      onStatus: (nextStatus) => {
        if (!active) return;
        setWatermarkStatus(nextStatus);
        if (nextStatus.state === 'late' || nextStatus.state === 'error') {
          setWatermarkHasFrame(false);
        }
        if (nextStatus.state === 'error') {
          outputVideo.srcObject = null;
        }
        if (lastStatusState !== nextStatus.state) {
          lastStatusState = nextStatus.state;
          logDiagnostic(nextStatus.state === 'error' ? 'warn' : 'info', 'watermark.processor.state', {
            state: nextStatus.state,
            message: nextStatus.message,
            latencyMs: nextStatus.latencyMs,
            outputFps: nextStatus.outputFps,
          });
        }
      },
    });
    watermarkProcessorRef.current = processor;
    const outputVideoWithCallbacks = outputVideo as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: { width: number; height: number }) => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const watchPresentedFrames = () => {
      if (!active) return;
      if (outputVideoWithCallbacks.requestVideoFrameCallback) {
        frameCallback = outputVideoWithCallbacks.requestVideoFrameCallback((_now, metadata) => {
          if (!active) return;
          if (metadata.width > 0 && processor.getStatus().state !== 'late' && processor.getStatus().state !== 'error') {
            setWatermarkHasFrame(true);
          }
          watchPresentedFrames();
        });
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        if (outputVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && outputVideo.videoWidth > 0 && processor.getStatus().state !== 'late') {
          setWatermarkHasFrame(true);
        }
        watchPresentedFrames();
      });
    };
    void processor.start().then(async (stream) => {
      if (!active) {
        processor.stop();
        return;
      }
      outputStream = stream;
      outputVideo.srcObject = stream;
      await outputVideo.play();
      if (active) watchPresentedFrames();
    }).catch((error: unknown) => {
      if (!active) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      processor.fail(errorMessage);
      outputVideo.srcObject = null;
      logDiagnostic('warn', 'watermark.processor.failed', { message: errorMessage });
      setWatermarkHasFrame(false);
      setWatermarkStatus({ ...initialWatermarkStatus('error'), message: errorMessage });
    });
    return () => {
      active = false;
      if (frameCallback !== null) outputVideoWithCallbacks.cancelVideoFrameCallback?.(frameCallback);
      window.cancelAnimationFrame(animationFrame);
      if (outputVideo.srcObject === outputStream) outputVideo.srcObject = null;
      processor.stop();
      if (watermarkProcessorRef.current === processor) watermarkProcessorRef.current = null;
    };
  }, [pendingGarmentId, queuedGarmentId, remoteReady, remoteStreamGeneration, watermarkEnabled]);

  useEffect(() => {
    try {
      if (cameraDeviceId) window.localStorage.setItem(cameraPreferenceKey, cameraDeviceId);
      else window.localStorage.removeItem(cameraPreferenceKey);
    } catch {
    }
  }, [cameraDeviceId]);

  useEffect(() => {
    if (garmentGroups.some((group) => group.id === activeGroupId)) return;
    setActiveGroupId(garmentGroups[0]?.id ?? null);
  }, [activeGroupId, garmentGroups]);

  useEffect(() => {
    setGroupPage(0);
  }, [activeGroupId]);

  useEffect(() => {
    if (!connectionRef.current || pendingGarmentIdRef.current || selectedIdRef.current) return;
    const firstGarment = garments.find((garment) => garment.enabled);
    if (firstGarment) void selectGarment(firstGarment);
  }, [garments, selectGarment]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) return;
      if (sessionIdRef.current || status === 'starting') void stop('页面隐藏');
      else if (localStreamRef.current || cameraOpenPromiseRef.current) closeCameraPreview();
    };
    const onPageHide = () => {
      if (sessionIdRef.current || status === 'starting') void stop('页面离开');
      else if (localStreamRef.current || cameraOpenPromiseRef.current) closeCameraPreview();
    };
    const onFullscreen = () => setIsFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [closeCameraPreview, status, stop]);

  useEffect(() => {
    if (!connectionRef.current || !sessionIdRef.current || status === 'idle' || status === 'stopped' || status === 'error') return;
    let disposed = false;
    const readStats = async () => {
      const connection = connectionRef.current;
      if (!connection) return;
      try {
        const stats = await connection.getMediaStats();
        if (!disposed) setMediaStats(stats);
      } catch {
        // Stats are optional and can be unavailable while WebRTC is negotiating.
      }
    };
    void readStats();
    const timer = window.setInterval(() => void readStats(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [remoteReady, status]);

  useEffect(() => {
    const onExtensionGarment = (event: MessageEvent<unknown>) => {
      const isExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(event.origin);
      if (window.parent === window || event.source !== window.parent || !isExtensionOrigin || !new URLSearchParams(window.location.search).has('extension') || !event.data || typeof event.data !== 'object') return;
      const payload = event.data as { type?: unknown; imageData?: unknown; name?: unknown };
      if (payload.type !== 'anywear-garment-image' || typeof payload.imageData !== 'string') return;
      if (payload.imageData.length > Math.ceil(maxUploadBytes / 3) * 4 + 64) {
        setMessage('衣服图片不能超过 10 MB');
        return;
      }
      void dataUrlToFile(payload.imageData, typeof payload.name === 'string' ? payload.name : '网页服装.png')
        .then(addUploadedGarment)
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener('message', onExtensionGarment);
    return () => window.removeEventListener('message', onExtensionGarment);
  }, [addUploadedGarment]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await workspaceRef.current?.requestFullscreen();
  };

  const openCompactWindow = () => {
    window.open(`${window.location.origin}/?compact=1`, 'anywear-compact', 'popup,width=460,height=820,resizable=yes');
  };

  const toggleGarmentPanel = () => {
    toggleCollapsedPreference(panelPreferenceKeys.garments, setGarmentPanelCollapsed);
  };

  const activeGarment = garments.find((garment) => garment.id === selectedId);
  const activeGroup = garmentGroups.find((group) => group.id === activeGroupId) ?? garmentGroups[0];
  const garmentDisplayNames = new Map<string, string>();
  let garmentIndex = 0;
  garmentGroups.forEach((group) => {
    group.garments.forEach((garment) => {
      garmentDisplayNames.set(garment.id, formatGarmentLabel(garmentIndex));
      garmentIndex += 1;
    });
  });
  const getGarmentDisplayName = (garment: Garment | undefined) => garment
    ? garmentDisplayNames.get(garment.id) ?? formatGarmentLabel(0)
    : '选择一件上衣';
  const pageCount = activeGroup ? Math.max(1, Math.ceil(activeGroup.garments.length / garmentsPerPage)) : 0;
  const currentPage = Math.min(groupPage, Math.max(0, pageCount - 1));
  const visibleGarments = activeGroup?.garments.slice(currentPage * garmentsPerPage, (currentPage + 1) * garmentsPerPage) ?? [];
  const handleGarmentGridWheel = useCallback((event: WheelEvent) => {
    const grid = garmentGridRef.current;
    if (!grid) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const maxScrollLeft = grid.scrollWidth - grid.clientWidth;
    if (maxScrollLeft <= 0 || delta === 0) return;
    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, grid.scrollLeft + delta));
    if (nextScrollLeft === grid.scrollLeft) return;
    event.preventDefault();
    grid.scrollLeft = nextScrollLeft;
  }, []);
  useEffect(() => {
    const grid = garmentGridRef.current;
    if (!grid) return;
    grid.addEventListener('wheel', handleGarmentGridWheel, { passive: false });
    return () => grid.removeEventListener('wheel', handleGarmentGridWheel);
  }, [garmentPanelCollapsed, handleGarmentGridWheel, visibleGarments.length]);
  const canStart = status !== 'starting' && status !== 'live' && status !== 'switching';
  const isRunning = status === 'starting' || status === 'live' || status === 'switching';
  const cameraPreviewActive = cameraPreviewState === 'open';
  const cameraSettingsLocked = isRunning || cameraPreviewState !== 'closed';
  const toggleWatermarkProcessing = () => setWatermarkEnabled((enabled) => !enabled);
  const watermarkLatency = watermarkStatus.latencyMs === null ? '--' : `${Math.round(watermarkStatus.latencyMs)} ms`;
  const watermarkP95Latency = watermarkStatus.p95LatencyMs === null ? '--' : `${Math.round(watermarkStatus.p95LatencyMs)} ms`;
  const watermarkConfidence = watermarkStatus.detectionConfidence === null ? '--' : `${Math.round(watermarkStatus.detectionConfidence * 100)}%`;
  return (
    <main className={`mirror-shell ${isCompactWindow ? 'compact-shell' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><img src="/brand/qingye-tech-logo.png" alt="青叶科技" /></div>
          <div>
            <p className="eyebrow">LIVE FITTING ROOM</p>
            <h1>青叶科技 <AppVersion /></h1>
            <p className="brand-tagline">实时虚拟试衣</p>
          </div>
        </div>
        <div className="top-actions">
          <div className={`connection-pill ${cameraPreviewActive && !isRunning ? 'preview' : status}`} role="status" aria-label={cameraPreviewActive && !isRunning ? '摄像头预览' : statusLabels[status]}><span className="status-dot" /><span className="connection-label">{cameraPreviewActive && !isRunning ? '摄像头预览' : statusLabels[status]}</span></div>
          <button className="icon-button" type="button" onClick={() => window.location.assign(`/cards${isCompactWindow ? '?compact=1' : ''}`)} disabled={isRunning} aria-label="打开更多功能" title={isRunning ? '停止当前会话后打开更多功能' : '更多功能'}>
            <Compass size={17} />
          </button>
          {!isCompactWindow && <button className="icon-button" type="button" onClick={openCompactWindow} aria-label="打开小窗模式" title="打开小窗模式">
            <PictureInPicture2 size={18} />
          </button>}
        </div>
      </header>

      <div className={`workspace ${capturePanelCollapsed && diagnosticsPanelCollapsed ? 'is-controls-collapsed' : ''}`} ref={workspaceRef}>
        <section className={`preview-column ${viewOrientation === 'portrait' ? 'is-portrait' : ''} ${flipHorizontal ? 'is-flipped-horizontal' : ''} ${flipVertical ? 'is-flipped-vertical' : ''}`} aria-label="实时试衣画面">
          <div className="video-frame">
            <video ref={localVideoRef} className="video-layer local-video" autoPlay muted playsInline onLoadedMetadata={(event) => {
              if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) setCameraSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
            }} />
            <video ref={remoteVideoRef} className={`video-layer remote-video ${remoteReady && !(watermarkEnabled && watermarkHasFrame) ? 'is-visible' : ''}`} autoPlay muted playsInline onLoadedMetadata={(event) => {
              if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
                setRemoteSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                logDiagnostic('info', 'media.remote-resolution', { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                setRemoteReady(true);
              }
            }} />
            <canvas ref={processedCanvasRef} className="watermark-processing-canvas" aria-hidden="true" />
            <video ref={processedVideoRef} className={`video-layer remote-video processed-video ${watermarkEnabled && watermarkHasFrame ? 'is-visible' : ''}`} muted autoPlay playsInline aria-hidden="true" />
            <div className="stage-shade" />

            {!remoteReady && !cameraPreviewActive && (
              <div className="stage-message">
                {status === 'starting' ? <LoaderCircle className="spin" size={34} /> : status === 'error' ? <AlertCircle size={34} /> : <Camera size={34} />}
                <strong>{status === 'error' ? '连接未完成' : status === 'starting' ? '正在准备镜面' : '准备开始实时试衣'}</strong>
                {message && <span>{message}</span>}
              </div>
            )}

            <div className="stage-meta">
              <div className="meta-item"><Wifi size={15} /> <span>{cameraPreviewActive && !isRunning ? '摄像头预览' : stateLabels[sessionState]}</span></div>
              {watermarkEnabled && remoteReady && <div className={`meta-item watermark-status-badge is-${watermarkStatus.state}`} title={watermarkStatus.message ?? watermarkStateLabels[watermarkStatus.state]}><Sparkles size={14} /> <span>{watermarkStateLabels[watermarkStatus.state]}</span></div>}
              {usageSeconds > 0 && <div className="usage-counter">{usageSeconds}s</div>}
            </div>
          </div>

          <div className={`stage-toolbar ${viewOrientation === 'portrait' ? 'is-portrait' : ''}`}>
            <div className="orientation-switch" role="group" aria-label="试衣画面方向">
              <button className="orientation-button" type="button" onClick={() => setViewOrientation('landscape')} aria-label="横向视图" title="横向视图" aria-pressed={viewOrientation === 'landscape'}>
                <Monitor size={16} />
              </button>
              <button className="orientation-button" type="button" onClick={() => setViewOrientation('portrait')} aria-label="竖向视图" title="竖向视图" aria-pressed={viewOrientation === 'portrait'}>
                <Smartphone size={16} />
              </button>
            </div>
            <div className="flip-switch" role="group" aria-label="视频画面翻转">
              <button className="orientation-button flip-control-button" type="button" onClick={() => setFlipHorizontal((flipped) => !flipped)} aria-label="左右翻转" title={`${flipHorizontal ? '关闭' : '开启'}左右翻转`} aria-pressed={flipHorizontal}>
                <FlipHorizontal2 size={16} /><span>左右翻转</span>
              </button>
              <button className="orientation-button flip-control-button" type="button" onClick={() => setFlipVertical((flipped) => !flipped)} aria-label="上下翻转" title={`${flipVertical ? '关闭' : '开启'}上下翻转`} aria-pressed={flipVertical}>
                <FlipVertical2 size={16} /><span>上下翻转</span>
              </button>
            </div>
            <button className="orientation-button panel-toolbar-button watermark-toggle-button" type="button" onClick={toggleWatermarkProcessing} aria-label={watermarkEnabled ? '关闭本地水印修复' : '开启本地水印修复'} title={watermarkEnabled ? '关闭本地水印修复' : '开启本地水印修复'} aria-pressed={watermarkEnabled}>
              <Sparkles size={16} />
            </button>
            <button className="orientation-button panel-toolbar-button" type="button" onClick={() => toggleCollapsedPreference(panelPreferenceKeys.capture, setCapturePanelCollapsed)} aria-label={capturePanelCollapsed ? '展开采集参数栏' : '收起采集参数栏'} title={capturePanelCollapsed ? '展开采集参数栏' : '收起采集参数栏'} aria-controls="capture-parameter-panel" aria-expanded={!capturePanelCollapsed}>
              <SlidersHorizontal size={16} />
            </button>
            <button className="orientation-button panel-toolbar-button" type="button" onClick={() => toggleCollapsedPreference(panelPreferenceKeys.diagnostics, setDiagnosticsPanelCollapsed)} aria-label={diagnosticsPanelCollapsed ? '展开链路诊断栏' : '收起链路诊断栏'} title={diagnosticsPanelCollapsed ? '展开链路诊断栏' : '收起链路诊断栏'} aria-controls="diagnostics-panel" aria-expanded={!diagnosticsPanelCollapsed}>
              <Gauge size={16} />
            </button>
            <button className="icon-button fullscreen-garment-toggle" type="button" onClick={toggleGarmentPanel} aria-expanded={!garmentPanelCollapsed} aria-controls="garment-selection-panel" aria-label={garmentPanelCollapsed ? '展开服装选择' : '收起服装选择'} title={garmentPanelCollapsed ? '展开服装选择' : '收起服装选择'}>
              <Shirt size={17} />
            </button>
            <button className="icon-button stage-fullscreen-button" type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? '退出视频全屏' : '视频全屏'} title={isFullscreen ? '退出视频全屏' : '视频全屏'} aria-pressed={isFullscreen}>
              {isFullscreen ? <Minimize2 size={17} /> : <Expand size={17} />}
            </button>
          </div>

          <div id="garment-selection-panel" className={`bottom-panel ${garmentPanelCollapsed ? 'is-collapsed' : ''}`}>
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">{activeGroup ? `COLLECTION / ${activeGroup.name}` : 'COLLECTION'}</span>
              <h2>{getGarmentDisplayName(activeGarment)}</h2>
            </div>
            <div className="panel-actions">
              <input ref={(element) => {
                directoryInputRef.current = element;
                if (element) element.webkitdirectory = true;
              }} className="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={handleDirectoryImport} />
              <button className="secondary-button directory-import-button" type="button" onClick={() => directoryInputRef.current?.click()} disabled={isSavingGarments} title="选择并保存一个服装目录到本机" aria-label="选择图组目录">
                {isSavingGarments ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}<span>{isSavingGarments ? '正在保存' : '选择图组目录'}</span>
              </button>
              {status === 'error' ? <button className="primary-button" type="button" onClick={() => void start()} disabled={cameraPreviewState === 'opening'}><RefreshCw size={15} />重新连接</button>
                : canStart ? <button className="primary-button" type="button" onClick={() => void start()} disabled={cameraPreviewState === 'opening'}><Camera size={16} />开始试衣</button>
                  : <button className="stop-button" type="button" onClick={() => void stop()}><CircleStop size={16} />停止</button>}
            </div>
            <button className="icon-button panel-close-button" type="button" onClick={toggleGarmentPanel} aria-label="收起服装选择" title="收起服装选择">
              <X size={15} />
            </button>
          </div>
          {!garmentPanelCollapsed && (
          <div className="garment-browser">
              <div className="garment-tabs" role="tablist" aria-label="服装分组">
                {garmentGroups.map((group) => (
                  <button
                    key={group.id}
                    className={`garment-tab ${activeGroup?.id === group.id ? 'is-active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={activeGroup?.id === group.id}
                    onClick={() => {
                      setActiveGroupId(group.id);
                      setGroupPage(0);
                    }}
                  >
                    {group.name}<span>{group.garments.length}</span>
                  </button>
                ))}
              </div>
              {activeGroup && visibleGarments.length === 0 && <p className="empty-garment-group">此目录暂无可用服装</p>}
              {visibleGarments.length > 0 && <div ref={garmentGridRef} className="garment-grid" role="tabpanel" aria-label={`${activeGroup.name}服装`}>
              {visibleGarments.map((garment) => (
                <button
                  key={garment.id}
                  type="button"
                  onClick={() => void selectGarment(garment)}
                  aria-pressed={selectedId === garment.id}
                  aria-busy={pendingGarmentId === garment.id || queuedGarmentId === garment.id}
                  className={`garment-item ${selectedId === garment.id ? 'selected' : ''} ${pendingGarmentId === garment.id ? 'pending' : ''} ${queuedGarmentId === garment.id ? 'queued' : ''}`}
                >
                  <span className="garment-thumb"><img src={garment.image} alt="" /></span>
                  <span className="garment-name">{getGarmentDisplayName(garment)}</span>
                  {selectedId === garment.id && <span className="selected-mark"><Check size={13} /></span>}
                  {pendingGarmentId === garment.id && <span className="pending-mark"><LoaderCircle size={13} /></span>}
                  {queuedGarmentId === garment.id && <span className="queued-mark" aria-label="等待切换"><Clock3 size={13} /></span>}
                </button>
              ))}
              </div>}
              {pageCount > 1 && <nav className="garment-pagination" aria-label={`${activeGroup?.name ?? '服装'}分页`}>
                <button className="pagination-button" type="button" disabled={currentPage === 0} onClick={() => setGroupPage((page) => Math.max(0, page - 1))} aria-label="上一页">
                  <ChevronLeft size={16} />
                </button>
                <span>{currentPage + 1} / {pageCount}</span>
                <button className="pagination-button" type="button" disabled={currentPage === pageCount - 1} onClick={() => setGroupPage((page) => Math.min(pageCount - 1, page + 1))} aria-label="下一页">
                  <ChevronRight size={16} />
                </button>
              </nav>}
            </div>
          )}
          </div>
        </section>

        <aside className={`control-panel ${capturePanelCollapsed && diagnosticsPanelCollapsed ? 'is-collapsed' : ''}`} aria-label="试衣参数">
          <div className="control-floats">
            <div id="capture-parameter-panel" className={`control-float control-float-left ${capturePanelCollapsed ? 'is-collapsed' : ''}`}>
              <div className="control-heading">
                <div>
                  <span className="panel-kicker">CONTROL ROOM</span>
                  <h2>实时链路</h2>
                </div>
                <SlidersHorizontal size={19} />
              </div>

              <div className="control-section">
                <div className="section-title"><SlidersHorizontal size={15} />采集参数</div>
                <label className="field-label" htmlFor="camera-device">摄像头</label>
                <div className="camera-select-row">
                  <select id="camera-device" value={cameraDeviceId} onChange={(event) => setCameraDeviceId(event.target.value)} disabled={cameraSettingsLocked}>
                    <option value="">系统默认摄像头</option>
                    {cameraDeviceId && !cameraDevices.some((device) => device.deviceId === cameraDeviceId) && <option value={cameraDeviceId}>已记忆的摄像头（当前不可见）</option>}
                    {cameraDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                  </select>
                  <button className="icon-button camera-refresh-button" type="button" onClick={() => void refreshCameraDevices()} disabled={isRunning || cameraPreviewState === 'opening'} title="刷新摄像头列表" aria-label="刷新摄像头列表">
                    <RefreshCw size={15} />
                  </button>
                </div>
                <p className="control-note">设备名称需在安全页面并授权摄像头后由浏览器提供</p>
                <button className="secondary-button wide-button camera-preview-button" type="button" onClick={toggleCameraPreview} disabled={isRunning || cameraPreviewState === 'opening'}>
                  {cameraPreviewState === 'opening' ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}
                  {cameraPreviewState === 'opening' ? '正在开启摄像头' : cameraPreviewActive ? '关闭摄像头预览' : '开启摄像头预览'}
                </button>
                <label className="field-label" htmlFor="capture-profile">分辨率</label>
                <select id="capture-profile" value={captureProfileId} onChange={(event) => setCaptureProfileId(event.target.value as CaptureProfileId)} disabled={cameraSettingsLocked}>
                  {captureProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </select>
                <label className="field-label" htmlFor="frame-rate">帧率</label>
                <select id="frame-rate" value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))} disabled={cameraSettingsLocked}>
                  {frameRateOptions.map((option) => <option key={option} value={option}>{option} FPS</option>)}
                </select>
                <p className="control-note">默认请求 1080p；实际画质和带宽由摄像头、浏览器及网络自适应协商。</p>
                <input ref={uploadInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void handleUpload(event)} />
                <button className="secondary-button wide-button" type="button" onClick={() => uploadInputRef.current?.click()} disabled={isSavingGarments}>
                  {isSavingGarments ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}{isSavingGarments ? '正在保存服装' : '上传衣服照片'}
                </button>
              </div>
            </div>

            <div id="diagnostics-panel" className={`control-float control-float-right ${diagnosticsPanelCollapsed ? 'is-collapsed' : ''}`}>
              <div className="control-section">
                <div className="section-title"><Gauge size={15} />实际链路</div>
                <div className="metric-grid">
                  <div className="metric-item"><span>摄像头采集</span><strong>{formatDimension(cameraSize?.width ?? null, cameraSize?.height ?? null)}</strong></div>
                  <div className="metric-item"><span>远端视频</span><strong>{formatDimension(remoteSize?.width ?? null, remoteSize?.height ?? null)}</strong></div>
                  <div className="metric-item"><span>上行</span><strong>{formatBitrate(mediaStats?.outboundBitrateBps ?? null)}</strong></div>
                  <div className="metric-item"><span>下行</span><strong>{formatBitrate(mediaStats?.inboundBitrateBps ?? null)}</strong></div>
                  <div className="metric-item"><span>上行帧率</span><strong>{formatFps(mediaStats?.outboundFramesPerSecond ?? null)}</strong></div>
                  <div className="metric-item"><span>下行帧率</span><strong>{formatFps(mediaStats?.inboundFramesPerSecond ?? null)}</strong></div>
                </div>
                {mediaStats?.qualityLimitationReason && mediaStats.qualityLimitationReason !== 'none' && <p className="warning-note">上行受限：{mediaStats.qualityLimitationReason}</p>}
              </div>

              <div className="control-section watermark-diagnostics">
                <div className="section-title"><Sparkles size={15} />本机水印处理</div>
                <label className="watermark-toggle-row">
                  <span>启用处理</span>
                  <input type="checkbox" checked={watermarkEnabled} onChange={toggleWatermarkProcessing} />
                </label>
                <p className={`diagnostic-context ${watermarkStatus.state === 'repaired' ? 'is-secure' : ''}`}>
                  {watermarkStateLabels[watermarkStatus.state]}{watermarkStatus.message ? `：${watermarkStatus.message}` : ''}
                </p>
                <div className="metric-grid">
                  <div className="metric-item"><span>输入分辨率</span><strong>{formatDimension(remoteSize?.width ?? null, remoteSize?.height ?? null)}</strong></div>
                  <div className="metric-item"><span>输出帧率</span><strong>{formatFps(watermarkStatus.outputFps)}</strong></div>
                  <div className="metric-item"><span>本地额外延迟</span><strong>{watermarkLatency}</strong></div>
                  <div className="metric-item"><span>本地延迟 P95</span><strong>{watermarkP95Latency}</strong></div>
                  <div className="metric-item"><span>检测置信度</span><strong>{watermarkConfidence}</strong></div>
                  <div className="metric-item"><span>跳帧 / 原帧回退</span><strong>{watermarkStatus.droppedFrames} / {watermarkStatus.fallbackFrames}</strong></div>
                </div>
                {watermarkStatus.lastFrameFallback && <p className="warning-note">最近输出帧未能可靠修复，保留原始画面。</p>}
                <p className="control-note">处理结果通过本机 Canvas 视频流播放；不改动供应商上行流。</p>
              </div>

              <div className="control-section">
                <div className="section-title"><Wifi size={15} />诊断日志</div>
                <p className={`diagnostic-context ${window.isSecureContext ? 'is-secure' : 'is-insecure'}`}>
                  {window.isSecureContext ? '安全上下文，可申请摄像头' : '当前 HTTP 来源不支持摄像头，请使用 HTTPS'}
                </p>
                <button className="secondary-button wide-button" type="button" onClick={() => {
                  logDiagnostic('info', 'diagnostics.exported', { entries: diagnosticLogs.length });
                  downloadDiagnosticLogs();
                }}>
                  <Download size={15} />导出诊断日志（{diagnosticLogs.length}）
                </button>
                <details className="diagnostic-details">
                  <summary>最近记录</summary>
                  <ol className="diagnostic-list">
                    {diagnosticLogs.slice(-6).reverse().map((entry, index) => (
                      <li className={`diagnostic-entry ${entry.level}`} key={`${entry.timestamp}-${entry.event}-${index}`}>
                        <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                        <strong>{entry.event}</strong>
                        {typeof entry.details?.message === 'string' && <span>{entry.details.message}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>

              <div className="control-actions">
                {status === 'error' ? <button className="primary-button wide-button" type="button" onClick={() => void start()} disabled={cameraPreviewState === 'opening'}><RefreshCw size={15} />重新连接</button>
                  : canStart ? <button className="primary-button wide-button" type="button" onClick={() => void start()} disabled={cameraPreviewState === 'opening'}><Camera size={16} />开始试衣</button>
                    : <button className="stop-button wide-button" type="button" onClick={() => void stop()}><CircleStop size={16} />停止</button>}
              </div>
              {message && status !== 'error' && <div className="toast"><AlertCircle size={15} />{message}<button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
              {status === 'error' && <div className="error-ribbon"><WifiOff size={15} />{message || '请检查网络、API Key 与供应商额度'}</div>}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

export default App;
