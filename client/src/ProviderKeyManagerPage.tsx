import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, KeyRound, LoaderCircle, Plus, Power, RefreshCw, Trash2, Users } from 'lucide-react';
import { addAdminProviderKey, fetchAdminProviderKeys, removeAdminProviderKey, setAdminProviderKeyEnabled } from './api';
import type { AdminProviderKeyCard } from './types';

function ProviderKeyManagerPage() {
  const [cards, setCards] = useState<AdminProviderKeyCard[]>([]);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [visibleKeyIds, setVisibleKeyIds] = useState<Set<string>>(() => new Set());

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const pool = await fetchAdminProviderKeys();
      setCards(pool.cards);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '卡池状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = '青叶科技 | 管理 API 卡池';
    void loadCards();
  }, [loadCards]);

  const addKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const pool = await addAdminProviderKey(trimmedKey, label.trim() || undefined);
      setCards(pool.cards);
      setKey('');
      setLabel('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加 API Key 失败');
    } finally {
      setSubmitting(false);
    }
  };

  const removeKey = async (id: string) => {
    if (removingId) return;
    setRemovingId(id);
    setError('');
    try {
      const pool = await removeAdminProviderKey(id);
      setCards(pool.cards);
      setVisibleKeyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '移除 API Key 失败');
    } finally {
      setRemovingId(null);
    }
  };

  const toggleKey = async (card: AdminProviderKeyCard) => {
    if (updatingId) return;
    setUpdatingId(card.id);
    setError('');
    try {
      const pool = await setAdminProviderKeyEnabled(card.id, !card.enabled);
      setCards(pool.cards);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新 API Key 状态失败');
    } finally {
      setUpdatingId(null);
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
          <button className="icon-button" type="button" onClick={() => void loadCards()} disabled={loading || submitting || removingId !== null || updatingId !== null} aria-label="刷新卡池" title="刷新卡池">
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </button>
          <a className="secondary-button provider-back-button" href="/cards"><ArrowLeft size={15} />返回卡池</a>
        </div>
      </header>

      <section className="provider-settings provider-manager" aria-labelledby="provider-manager-title">
        <div className="provider-page-heading">
          <span className="panel-kicker">PROVIDER ADMINISTRATION</span>
          <h2 id="provider-manager-title">管理 API 卡池</h2>
          <p>{loading ? '正在读取卡池状态' : `已配置 ${cards.length} 张 API 卡`}</p>
        </div>

        <form className="provider-key-form" onSubmit={(event) => void addKey(event)}>
          <div className="provider-key-form-heading"><KeyRound size={16} /><strong>添加 API Key</strong></div>
          <div className="provider-key-fields">
            <label className="provider-field"><span>API Key</span><input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" required disabled={submitting} placeholder="输入新的 API Key" /></label>
            <label className="provider-field"><span>标签（可选）</span><input type="text" value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" disabled={submitting} placeholder="例如：备用额度" /></label>
            <button className="primary-button provider-add-button" type="submit" disabled={submitting || !key.trim()}>
              {submitting ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}添加
            </button>
          </div>
        </form>

        {error && <div className="error-ribbon provider-manager-error" role="alert">{error}</div>}
        {!loading && !error && cards.length === 0 && <p className="provider-empty">尚未配置 API 卡</p>}
        {!loading && cards.length > 0 && (
          <div className="provider-manager-list" aria-label="已配置 API 卡">
            {cards.map((card) => {
              const keyHintVisible = visibleKeyIds.has(card.id);
              const removing = removingId === card.id;
              return (
                <article className={`provider-manager-card ${card.enabled ? '' : 'is-disabled'}`} key={card.id}>
                  <div className="provider-card-number">{String(card.number).padStart(2, '0')}</div>
                  <div className="provider-manager-card-copy">
                    <strong>{card.label || `卡号 ${card.number}`}{card.enabled ? '' : '（已停用）'}</strong>
                    <span className="provider-key-hint">{keyHintVisible ? card.keyHint : '••••••••••••'}</span>
                  </div>
                  <div className="provider-manager-card-meta"><Users size={14} />活跃会话 {card.activeSessions}</div>
                  <div className="provider-manager-card-actions">
                    <button className="icon-button provider-card-action" type="button" onClick={() => void toggleKey(card)} disabled={updatingId !== null || removingId !== null} aria-label={card.enabled ? '停用 API Key' : '启用 API Key'} title={card.enabled ? '停用后不再分配给新会话' : '重新加入自动轮询'}>
                      {updatingId === card.id ? <LoaderCircle className="spin" size={16} /> : <Power size={16} />}
                    </button>
                    <button className="icon-button provider-card-action" type="button" onClick={() => toggleKeyHint(card.id)} aria-label={keyHintVisible ? '隐藏密钥提示' : '查看密钥提示'} title={keyHintVisible ? '隐藏密钥提示' : '查看密钥提示'}>
                      {keyHintVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button className="icon-button provider-card-action provider-remove-button" type="button" onClick={() => void removeKey(card.id)} disabled={removingId !== null || updatingId !== null || card.activeSessions > 0} aria-label={`移除${card.label || `卡号 ${card.number}`}`} title={card.activeSessions > 0 ? '活跃会话结束后才能移除' : '移除 API Key'}>
                      {removing ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

export default ProviderKeyManagerPage;
