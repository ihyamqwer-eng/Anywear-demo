import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Eye, EyeOff, FolderPlus, KeyRound, LoaderCircle, Pencil, Plus, Power, RefreshCw, Trash2, Users, X } from 'lucide-react';
import {
  activateAdminProviderKeyGroup,
  addAdminProviderKeyToGroup,
  createAdminProviderKeyGroup,
  fetchAdminProviderKeys,
  moveAdminProviderKeyToGroup,
  removeAdminProviderKey,
  removeAdminProviderKeyGroup,
  renameAdminProviderKeyGroup,
  setAdminProviderKeyEnabled,
} from './api';
import type { AdminProviderKeyCard, AdminProviderKeyPoolStatus } from './types';

function ProviderKeyManagerPage() {
  const [pool, setPool] = useState<AdminProviderKeyPoolStatus | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamedGroupName, setRenamedGroupName] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [visibleKeyIds, setVisibleKeyIds] = useState<Set<string>>(() => new Set());

  const applyPool = useCallback((nextPool: AdminProviderKeyPoolStatus) => {
    setPool(nextPool);
    const fallbackGroup = nextPool.groups.find((group) => group.id === nextPool.activeGroupId) ?? nextPool.groups[0];
    setSelectedGroupId((current) => nextPool.groups.some((group) => group.id === current) ? current : fallbackGroup?.id ?? '');
  }, []);

  const loadPool = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      applyPool(await fetchAdminProviderKeys());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '卡池状态读取失败');
    } finally {
      setLoading(false);
    }
  }, [applyPool]);

  useEffect(() => {
    document.title = '青叶科技 | 管理 API 卡池';
    void loadPool();
  }, [loadPool]);

  const selectedGroup = pool?.groups.find((group) => group.id === selectedGroupId) ?? null;
  const cards = selectedGroup?.cards ?? [];
  const totalCards = pool?.groups.reduce((total, group) => total + group.cards.length, 0) ?? 0;
  const busy = pendingAction !== null;

  const addKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey || !selectedGroup || busy) return;
    setPendingAction('add-key');
    setError('');
    try {
      applyPool(await addAdminProviderKeyToGroup(trimmedKey, label.trim() || undefined, selectedGroup.id));
      setKey('');
      setLabel('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加 API Key 失败');
    } finally {
      setPendingAction(null);
    }
  };

  const createGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name || busy) return;
    if (!window.confirm('新建分组后会立即设为生效。新分组暂时没有 API 卡，新会话可能无法使用服务。仍要继续吗？')) return;
    setPendingAction('create-group');
    setError('');
    try {
      const previousIds = new Set(pool?.groups.map((group) => group.id) ?? []);
      const nextPool = await createAdminProviderKeyGroup(name);
      const createdGroup = nextPool.groups.find((group) => !previousIds.has(group.id));
      applyPool(nextPool);
      if (createdGroup) setSelectedGroupId(createdGroup.id);
      setNewGroupName('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建分组失败');
    } finally {
      setPendingAction(null);
    }
  };

  const renameGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = renamedGroupName.trim();
    if (!name || !renamingGroupId || busy) return;
    setPendingAction('rename-group');
    setError('');
    try {
      applyPool(await renameAdminProviderKeyGroup(renamingGroupId, name));
      setRenamingGroupId(null);
      setRenamedGroupName('');
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '重命名分组失败');
    } finally {
      setPendingAction(null);
    }
  };

  const activateGroup = async () => {
    if (!selectedGroup || selectedGroup.id === pool?.activeGroupId || busy) return;
    setPendingAction('activate-group');
    setError('');
    try {
      applyPool(await activateAdminProviderKeyGroup(selectedGroup.id));
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : '启用分组失败');
    } finally {
      setPendingAction(null);
    }
  };

  const deleteGroup = async () => {
    if (!selectedGroup || busy || selectedGroup.id === pool?.activeGroupId || selectedGroup.cards.length > 0) return;
    const confirmed = window.confirm(`确定删除空分组“${selectedGroup.name}”？此操作无法撤销。`);
    if (!confirmed) return;
    setPendingAction('delete-group');
    setError('');
    try {
      applyPool(await removeAdminProviderKeyGroup(selectedGroup.id));
      setRenamingGroupId(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除分组失败');
    } finally {
      setPendingAction(null);
    }
  };

  const removeKey = async (card: AdminProviderKeyCard) => {
    if (busy || card.activeSessions > 0) return;
    const confirmed = window.confirm(`确定移除“${card.label || `卡号 ${card.number}`}”吗？此操作无法撤销。`);
    if (!confirmed) return;
    setPendingAction(`remove-key:${card.id}`);
    setError('');
    try {
      applyPool(await removeAdminProviderKey(card.id));
      setVisibleKeyIds((current) => {
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '移除 API Key 失败');
    } finally {
      setPendingAction(null);
    }
  };

  const toggleKey = async (card: AdminProviderKeyCard) => {
    if (busy) return;
    if (card.enabled && !window.confirm(`确定停用“${card.label || `卡号 ${card.number}`}”？停用只影响新会话，已运行会话不受影响。`)) return;
    setPendingAction(`toggle-key:${card.id}`);
    setError('');
    try {
      applyPool(await setAdminProviderKeyEnabled(card.id, !card.enabled));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新 API Key 状态失败');
    } finally {
      setPendingAction(null);
    }
  };

  const moveKey = async (card: AdminProviderKeyCard, groupId: string) => {
    if (busy || !selectedGroup || groupId === selectedGroup.id) return;
    setPendingAction(`move-key:${card.id}`);
    setError('');
    try {
      applyPool(await moveAdminProviderKeyToGroup(card.id, groupId));
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : '迁移 API 卡失败');
    } finally {
      setPendingAction(null);
    }
  };

  const toggleKeyHint = (id: string) => {
    setVisibleKeyIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <main className="mirror-shell provider-keys-shell provider-manager-shell">
      <header className="topbar provider-page-topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><img src="/brand/qingye-tech-logo.png" alt="青叶科技" /></div>
          <div>
            <p className="eyebrow">LIVE FITTING ROOM</p>
            <h1>青叶科技</h1>
            <p className="brand-tagline">实时虚拟试衣</p>
          </div>
        </div>
        <div className="provider-page-actions">
          <button className="icon-button" type="button" onClick={() => void loadPool()} disabled={loading || busy} aria-label="刷新卡池" title="刷新卡池">
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </button>
          <a className="secondary-button provider-back-button" href="/cards"><ArrowLeft size={15} />返回卡池</a>
        </div>
      </header>

      <section className="provider-settings provider-manager" aria-labelledby="provider-manager-title">
        <div className="provider-page-heading">
          <span className="panel-kicker">PROVIDER ADMINISTRATION</span>
          <h2 id="provider-manager-title">管理 API 卡池</h2>
          <p>{loading ? '正在读取卡池状态' : `已配置 ${totalCards} 张 API 卡 · ${pool?.groups.length ?? 0} 个分组`}</p>
        </div>

        <form className="provider-group-create" onSubmit={(event) => void createGroup(event)}>
          <label className="provider-field">
            <span>新建分组</span>
            <input type="text" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} maxLength={80} required disabled={busy} placeholder="输入分组名称" />
            <small className="provider-group-create-note">创建后立即设为生效；新会话将使用该组。</small>
          </label>
          <button className="secondary-button" type="submit" disabled={busy || !newGroupName.trim()}>
            {pendingAction === 'create-group' ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}创建分组
          </button>
        </form>

        {pool && pool.groups.length > 0 && (
          <section className="provider-group-management" aria-label="API 卡池分组">
            <div className="provider-group-tabs" aria-label="选择要查看的分组">
              {pool.groups.map((group) => (
                <button className={`provider-group-tab ${group.id === selectedGroupId ? 'is-selected' : ''}`} key={group.id} type="button" aria-pressed={group.id === selectedGroupId} onClick={() => setSelectedGroupId(group.id)}>
                  <span>{group.name}</span>
                  <small>{group.cards.length}</small>
                  {group.id === pool.activeGroupId && <strong>生效</strong>}
                </button>
              ))}
            </div>

            {selectedGroup && (
              <div className="provider-group-heading">
                <div className="provider-group-title">
                  {renamingGroupId === selectedGroup.id ? (
                    <form className="provider-group-rename-form" onSubmit={(event) => void renameGroup(event)}>
                      <label className="visually-hidden" htmlFor="provider-group-rename">分组名称</label>
                      <input id="provider-group-rename" type="text" value={renamedGroupName} onChange={(event) => setRenamedGroupName(event.target.value)} maxLength={80} required disabled={busy} autoFocus />
                      <button className="icon-button provider-card-action" type="submit" disabled={busy || !renamedGroupName.trim()} aria-label="保存分组名称" title="保存分组名称">
                        {pendingAction === 'rename-group' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                      </button>
                      <button className="icon-button provider-card-action" type="button" onClick={() => setRenamingGroupId(null)} disabled={busy} aria-label="取消重命名" title="取消重命名"><X size={15} /></button>
                    </form>
                  ) : (
                    <>
                      <h3>{selectedGroup.name}</h3>
                      {selectedGroup.id === pool.activeGroupId && <span className="provider-group-active">当前生效</span>}
                    </>
                  )}
                  <span className="provider-group-count">{selectedGroup.cards.length} 张卡</span>
                </div>
                <div className="provider-group-actions">
                  {selectedGroup.id !== pool.activeGroupId && (
                    <button className="secondary-button" type="button" onClick={() => void activateGroup()} disabled={busy} title="仅影响新会话；已运行会话不受影响">
                      {pendingAction === 'activate-group' ? <LoaderCircle className="spin" size={15} /> : <Power size={15} />}设为生效
                    </button>
                  )}
                  {renamingGroupId !== selectedGroup.id && <button className="icon-button provider-card-action" type="button" onClick={() => { setRenamingGroupId(selectedGroup.id); setRenamedGroupName(selectedGroup.name); }} disabled={busy} aria-label={`重命名分组 ${selectedGroup.name}`} title="重命名分组"><Pencil size={15} /></button>}
                  <button className="icon-button provider-card-action provider-remove-button" type="button" onClick={() => void deleteGroup()} disabled={busy || selectedGroup.id === pool.activeGroupId || selectedGroup.cards.length > 0} aria-label={`删除分组 ${selectedGroup.name}`} title={selectedGroup.id === pool.activeGroupId ? '先启用其他分组再删除' : selectedGroup.cards.length > 0 ? '请先将组内 API 卡迁出' : '删除空分组'}>
                    {pendingAction === 'delete-group' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                  </button>
                </div>
              </div>
            )}
            <p className="provider-group-note">启用分组只决定新会话使用的卡池；已运行会话不受影响。</p>
          </section>
        )}

        {error && <div className="error-ribbon provider-manager-error" role="alert">{error}</div>}
        {!loading && !error && pool?.groups.length === 0 && <p className="provider-empty">尚未创建 API 卡分组</p>}
        {!loading && !error && pool && pool.groups.length > 0 && selectedGroup && (
          <>
            <form className="provider-key-form" onSubmit={(event) => void addKey(event)}>
              <div className="provider-key-form-heading"><KeyRound size={16} /><strong>添加 API Key</strong><span>添加到“{selectedGroup.name}”</span></div>
              <div className="provider-key-fields">
                <label className="provider-field"><span>API Key</span><input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" required disabled={busy} placeholder="输入新的 API Key" /></label>
                <label className="provider-field"><span>标签（可选）</span><input type="text" value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" disabled={busy} placeholder="例如：备用额度" /></label>
                <button className="primary-button provider-add-button" type="submit" disabled={busy || !key.trim()}>
                  {pendingAction === 'add-key' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}添加
                </button>
              </div>
            </form>

            {cards.length === 0 ? <p className="provider-empty">此分组尚未配置 API 卡</p> : (
              <div className="provider-manager-list" aria-label={`${selectedGroup.name}中的 API 卡`}>
                {cards.map((card) => {
                  const keyHintVisible = visibleKeyIds.has(card.id);
                  const actionPending = pendingAction?.endsWith(`:${card.id}`) ?? false;
                  return (
                    <article className={`provider-manager-card provider-manager-card-grouped ${card.enabled ? '' : 'is-disabled'}`} key={card.id}>
                      <div className="provider-card-number">{String(card.number).padStart(2, '0')}</div>
                      <div className="provider-manager-card-copy">
                        <strong>{card.label || `卡号 ${card.number}`}{card.enabled ? '' : '（已停用）'}</strong>
                        <span className="provider-key-hint">{keyHintVisible ? card.keyHint : '••••••••••••'}</span>
                      </div>
                      <div className="provider-manager-card-meta"><Users size={14} />活跃会话 {card.activeSessions}</div>
                      <label className="provider-card-move-label">
                        <span className="visually-hidden">迁移 API 卡到其他分组</span>
                        <select className="provider-card-move" value={selectedGroup.id} onChange={(event) => void moveKey(card, event.target.value)} disabled={busy || pool.groups.length < 2 || card.activeSessions > 0} aria-label={`迁移${card.label || `卡号 ${card.number}`}到其他分组`} title={card.activeSessions > 0 ? '活跃会话结束后才能移动' : '移动后只会参与目标分组的轮询'}>
                          {pool.groups.map((group) => <option key={group.id} value={group.id}>{group.id === selectedGroup.id ? '当前分组' : `移至 ${group.name}`}</option>)}
                        </select>
                      </label>
                      <div className="provider-manager-card-actions">
                        <button className="icon-button provider-card-action" type="button" onClick={() => void toggleKey(card)} disabled={busy} aria-label={card.enabled ? '停用 API Key' : '启用 API Key'} title={card.enabled ? '停用仅影响新会话；运行中的会话不受影响' : '重新加入自动轮询'}>
                          {actionPending && pendingAction?.startsWith('toggle-key:') ? <LoaderCircle className="spin" size={16} /> : <Power size={16} />}
                        </button>
                        <button className="icon-button provider-card-action" type="button" onClick={() => toggleKeyHint(card.id)} aria-label={keyHintVisible ? '隐藏密钥提示' : '查看密钥提示'} title={keyHintVisible ? '隐藏密钥提示' : '查看密钥提示'}>
                          {keyHintVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                        <button className="icon-button provider-card-action provider-remove-button" type="button" onClick={() => void removeKey(card)} disabled={busy || card.activeSessions > 0} aria-label={`移除${card.label || `卡号 ${card.number}`}`} title={card.activeSessions > 0 ? '活跃会话结束后才能移除' : '移除 API Key'}>
                          {actionPending && pendingAction?.startsWith('remove-key:') ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default ProviderKeyManagerPage;
