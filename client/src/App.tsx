import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CircleStop,
  Expand,
  Gauge,
  ImagePlus,
  LoaderCircle,
  PictureInPicture2,
  RefreshCw,
  Shirt,
  SlidersHorizontal,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { createSession, fetchGarments, imageToBase64, stopSession } from './api';
import { RealtimeConnection, type RealtimeMediaStats } from './realtime';
import type { Garment, ProviderMessage, SessionState } from './types';

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

const captureProfiles = [
  { id: '1080p', label: '1920 × 1080', width: 1920, height: 1080 },
  { id: '720p', label: '1280 × 720', width: 1280, height: 720 },
  { id: '540p', label: '960 × 540', width: 960, height: 540 },
] as const;

const frameRateOptions = [15, 20, 30] as const;
const bitrateOptions = [2_000_000, 4_000_000, 6_000_000] as const;
type CaptureProfileId = typeof captureProfiles[number]['id'];
const maxUploadBytes = 10 * 1024 * 1024;

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取衣服图片'));
    reader.readAsDataURL(file);
  });
}

function garmentNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, 40) || '上传服装';
}

function App() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const pendingGarmentIdRef = useRef<string | null>(null);
  const queuedGarmentRef = useRef<Garment | null>(null);
  const garmentTimeoutRef = useRef<number | undefined>(undefined);
  const garmentsRef = useRef<Garment[]>([]);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingGarmentId, setPendingGarmentId] = useState<string | null>(null);
  const [queuedGarmentId, setQueuedGarmentId] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewStatus>('idle');
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [message, setMessage] = useState('');
  const [usageSeconds, setUsageSeconds] = useState(0);
  const [remoteReady, setRemoteReady] = useState(false);
  const [cameraSize, setCameraSize] = useState<{ width: number; height: number } | null>(null);
  const [remoteSize, setRemoteSize] = useState<{ width: number; height: number } | null>(null);
  const [mediaStats, setMediaStats] = useState<RealtimeMediaStats | null>(null);
  const [captureProfileId, setCaptureProfileId] = useState<CaptureProfileId>('1080p');
  const [frameRate, setFrameRate] = useState<number>(30);
  const [maxVideoBitrate, setMaxVideoBitrate] = useState<number>(4_000_000);
  const captureProfile = captureProfiles.find((profile) => profile.id === captureProfileId) ?? captureProfiles[0];
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [garmentPanelCollapsed, setGarmentPanelCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('anywear-garment-panel-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const isCompactWindow = new URLSearchParams(window.location.search).has('compact');
  const showError = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    setMessage(text);
    setStatus('error');
    setSessionState('error');
  }, []);

  const releaseMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setRemoteReady(false);
    setCameraSize(null);
    setRemoteSize(null);
    setMediaStats(null);
  }, []);

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

  const addUploadedGarment = useCallback(async (imageData: string, name: string) => {
    if (!imageData.startsWith('data:image/')) {
      setMessage('请选择 JPG、PNG 或 WebP 图片');
      return;
    }
    const comma = imageData.indexOf(',');
    const encodedData = comma >= 0 ? imageData.slice(comma + 1) : imageData;
    const decodedBytes = Math.floor(encodedData.length * 3 / 4);
    if (decodedBytes > maxUploadBytes) {
      setMessage('衣服图片不能超过 10 MB');
      return;
    }
    const garment: Garment = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name || '上传服装',
      image: imageData,
      prompt: 'Replace the current upper-body garment with the uploaded garment. Preserve the person, pose, face, hands, and background.',
      enabled: true,
    };
    const nextGarments = [garment, ...garmentsRef.current.filter((item) => item.id !== garment.id)];
    garmentsRef.current = nextGarments;
    setGarments(nextGarments);
    selectedIdRef.current = garment.id;
    setSelectedId(garment.id);
    if (connectionRef.current) await selectGarment(garment);
  }, [selectGarment]);

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
      await addUploadedGarment(await readFileAsDataUrl(file), garmentNameFromFile(file.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [addUploadedGarment]);

  const start = useCallback(async () => {
    if (status === 'starting' || status === 'live' || status === 'switching') return;
    const lifecycle = ++lifecycleRef.current;
    setStatus('starting');
    setMessage('');
    setSessionState('camera_ready');
    let ownedSessionId: string | null = null;
    let ownedConnection: RealtimeConnection | null = null;
    try {
      const session = await createSession();
      ownedSessionId = session.sessionId;
      if (lifecycle !== lifecycleRef.current) {
        await stopSession(ownedSessionId).catch(() => undefined);
        return;
      }
      sessionIdRef.current = ownedSessionId;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: captureProfile.width, max: captureProfile.width },
          height: { ideal: captureProfile.height, max: captureProfile.height },
          frameRate: { ideal: frameRate, max: frameRate },
        },
        audio: false,
      });
      if (lifecycle !== lifecycleRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        await stopSession(ownedSessionId).catch(() => undefined);
        return;
      }
      localStreamRef.current = stream;
      const cameraSettings = stream.getVideoTracks()[0]?.getSettings();
      if (cameraSettings.width && cameraSettings.height) setCameraSize({ width: cameraSettings.width, height: cameraSettings.height });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play().catch(() => undefined);
      }
      const connection = new RealtimeConnection({
        session,
        localStream: stream,
        maxVideoBitrateBps: maxVideoBitrate,
        onRemoteStream: (remoteStream) => {
          if (sessionIdRef.current !== session.sessionId) return;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            void remoteVideoRef.current.play().catch(() => undefined);
          }
          setStatus('live');
        },
        onMessage: (providerMessage: ProviderMessage) => {
          if (sessionIdRef.current !== session.sessionId) return;
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
          if (peerState === 'connected') setSessionState('connected');
          if (peerState === 'failed') void failSession(new Error('WebRTC 媒体连接失败'));
        },
        onSignalState: (signalState) => {
          if (signalState !== 'closed' && sessionIdRef.current !== session.sessionId) return;
          if (signalState === 'open') setSessionState('signaling');
          if (signalState === 'closed' && sessionIdRef.current === session.sessionId) void failSession(new Error('信令连接已关闭'));
        },
        onError: (error) => {
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
      ownedConnection?.close();
      if (connectionRef.current === ownedConnection) connectionRef.current = null;
      if (ownedSessionId) await stopSession(ownedSessionId).catch(() => undefined);
      if (lifecycle === lifecycleRef.current) {
        releaseMedia();
        if (sessionIdRef.current === ownedSessionId) sessionIdRef.current = null;
        showError(error);
      }
    }
  }, [captureProfile, failSession, frameRate, maxVideoBitrate, releaseMedia, selectGarment, showError, status, stop]);

  useEffect(() => {
    const queuedGarment = queuedGarmentRef.current;
    if (pendingGarmentId || !queuedGarmentId || !queuedGarment || !connectionRef.current) return;
    queuedGarmentRef.current = null;
    setQueuedGarmentId(null);
    void selectGarment(queuedGarment);
  }, [pendingGarmentId, queuedGarmentId, selectGarment]);

  useEffect(() => {
    fetchGarments().then((items) => {
      garmentsRef.current = items;
      setGarments(items);
    }).catch(showError);
    return () => {
      void teardown('idle');
    };
  }, [showError, teardown]);

  useEffect(() => {
    if (!connectionRef.current || pendingGarmentIdRef.current || selectedIdRef.current) return;
    const firstGarment = garments.find((garment) => garment.enabled);
    if (firstGarment) void selectGarment(firstGarment);
  }, [garments, selectGarment]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && sessionIdRef.current) void stop('页面隐藏');
    };
    const onPageHide = () => {
      if (sessionIdRef.current) void stop('页面离开');
    };
    const onFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [stop]);

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
      if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
      const payload = event.data as { type?: unknown; imageData?: unknown; name?: unknown };
      if (payload.type !== 'anywear-garment-image' || typeof payload.imageData !== 'string') return;
      void addUploadedGarment(payload.imageData, typeof payload.name === 'string' ? payload.name : '网页服装');
    };
    window.addEventListener('message', onExtensionGarment);
    return () => window.removeEventListener('message', onExtensionGarment);
  }, [addUploadedGarment]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  const openCompactWindow = () => {
    window.open(`${window.location.origin}/?compact=1`, 'anywear-compact', 'popup,width=460,height=820,resizable=yes');
  };

  const toggleGarmentPanel = () => {
    setGarmentPanelCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem('anywear-garment-panel-collapsed', String(next));
      } catch {
        // The control remains usable when browser storage is unavailable.
      }
      return next;
    });
  };

  const activeGarment = garments.find((garment) => garment.id === selectedId);
  const canStart = status !== 'starting' && status !== 'live' && status !== 'switching';
  const isRunning = status === 'starting' || status === 'live' || status === 'switching';
  return (
    <main className={`mirror-shell ${isCompactWindow ? 'compact-shell' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Shirt size={18} strokeWidth={1.8} /></div>
          <div>
            <p className="eyebrow">LIVE FITTING ROOM</p>
            <h1>Anywear Mirror</h1>
          </div>
        </div>
        <div className="top-actions">
          <div className={`connection-pill ${status}`}><span className="status-dot" />{statusLabels[status]}</div>
          {!isCompactWindow && <button className="icon-button" type="button" onClick={openCompactWindow} aria-label="打开小窗模式" title="打开小窗模式">
            <PictureInPicture2 size={18} />
          </button>}
          <button className="icon-button" type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? '退出全屏' : '进入全屏'} title={isFullscreen ? '退出全屏' : '进入全屏'}>
            <Expand size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="preview-column" aria-label="实时试衣画面">
          <div className="video-frame">
            <video ref={localVideoRef} className="video-layer local-video" autoPlay muted playsInline onLoadedMetadata={(event) => {
              if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) setCameraSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
            }} />
            <video ref={remoteVideoRef} className={`video-layer remote-video ${remoteReady ? 'is-visible' : ''}`} autoPlay muted playsInline onLoadedMetadata={(event) => {
              if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
                setRemoteSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                setRemoteReady(true);
              }
            }} />
            <div className="stage-shade" />

            {!remoteReady && (
              <div className="stage-message">
                {status === 'starting' ? <LoaderCircle className="spin" size={34} /> : status === 'error' ? <AlertCircle size={34} /> : <Camera size={34} />}
                <strong>{status === 'error' ? '连接未完成' : status === 'starting' ? '正在准备镜面' : '准备开始实时试衣'}</strong>
                {message && <span>{message}</span>}
              </div>
            )}

            <div className="stage-meta">
              <div className="meta-item"><Wifi size={15} /> <span>{stateLabels[sessionState]}</span></div>
              {usageSeconds > 0 && <div className="usage-counter">{usageSeconds}s</div>}
            </div>
          </div>

          <div className={`bottom-panel ${garmentPanelCollapsed ? 'is-collapsed' : ''}`}>
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">COLLECTION 01</span>
              <h2>{activeGarment?.name ?? '选择一件上衣'}</h2>
            </div>
            <div className="panel-actions">
              <button
                className="icon-button panel-toggle"
                type="button"
                onClick={toggleGarmentPanel}
                aria-expanded={!garmentPanelCollapsed}
                aria-label={garmentPanelCollapsed ? '展开服装选择' : '收起服装选择'}
                title={garmentPanelCollapsed ? '展开服装选择' : '收起服装选择'}
              >
                {garmentPanelCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
              {status === 'error' ? <button className="primary-button" type="button" onClick={() => void start()}><RefreshCw size={15} />重新连接</button>
                : canStart ? <button className="primary-button" type="button" onClick={() => void start()}><Camera size={16} />开始试衣</button>
                  : <button className="stop-button" type="button" onClick={() => void stop()}><CircleStop size={16} />停止</button>}
            </div>
          </div>
          {!garmentPanelCollapsed && (
            <div className="garment-rail">
              {garments.map((garment) => (
                <button
                  key={garment.id}
                  type="button"
                  onClick={() => void selectGarment(garment)}
                  aria-pressed={selectedId === garment.id}
                  aria-busy={pendingGarmentId === garment.id || queuedGarmentId === garment.id}
                  className={`garment-item ${selectedId === garment.id ? 'selected' : ''} ${pendingGarmentId === garment.id ? 'pending' : ''} ${queuedGarmentId === garment.id ? 'queued' : ''}`}
                >
                  <span className="garment-thumb"><img src={garment.image} alt="" /></span>
                  <span className="garment-name">{garment.name}</span>
                  {selectedId === garment.id && <span className="selected-mark"><Check size={13} /></span>}
                  {pendingGarmentId === garment.id && <span className="pending-mark"><LoaderCircle size={13} /></span>}
                  {queuedGarmentId === garment.id && <span className="queued-mark" aria-label="等待切换"><Clock3 size={13} /></span>}
                </button>
              ))}
            </div>
          )}
          </div>
        </section>

        <aside className="control-panel" aria-label="试衣参数">
          <div className="control-heading">
            <div>
              <span className="panel-kicker">CONTROL ROOM</span>
              <h2>实时链路</h2>
            </div>
            <SlidersHorizontal size={19} />
          </div>

          <div className="control-section">
            <div className="section-title"><SlidersHorizontal size={15} />采集参数</div>
            <label className="field-label" htmlFor="capture-profile">分辨率</label>
            <select id="capture-profile" value={captureProfileId} onChange={(event) => setCaptureProfileId(event.target.value as CaptureProfileId)} disabled={isRunning}>
              {captureProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
            <label className="field-label" htmlFor="frame-rate">帧率</label>
            <select id="frame-rate" value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))} disabled={isRunning}>
              {frameRateOptions.map((option) => <option key={option} value={option}>{option} FPS</option>)}
            </select>
            <label className="field-label" htmlFor="video-bitrate">上行码率上限</label>
            <select id="video-bitrate" value={maxVideoBitrate} onChange={(event) => setMaxVideoBitrate(Number(event.target.value))} disabled={isRunning}>
              {bitrateOptions.map((option) => <option key={option} value={option}>{option / 1_000_000} Mbps</option>)}
            </select>
            <p className="control-note">参数仅对下一次启动生效</p>
            <input ref={uploadInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void handleUpload(event)} />
            <button className="secondary-button wide-button" type="button" onClick={() => uploadInputRef.current?.click()}>
              <ImagePlus size={15} />上传衣服照片
            </button>
          </div>

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

          <div className="control-actions">
            {status === 'error' ? <button className="primary-button wide-button" type="button" onClick={() => void start()}><RefreshCw size={15} />重新连接</button>
              : canStart ? <button className="primary-button wide-button" type="button" onClick={() => void start()}><Camera size={16} />开始试衣</button>
                : <button className="stop-button wide-button" type="button" onClick={() => void stop()}><CircleStop size={16} />停止</button>}
          </div>
          {message && status !== 'error' && <div className="toast"><AlertCircle size={15} />{message}<button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
          {status === 'error' && <div className="error-ribbon"><WifiOff size={15} />{message || '请检查网络、API Key 与供应商额度'}</div>}
        </aside>
      </div>
    </main>
  );
}

export default App;
