import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, CircleDashed, Clock3, KeyRound, RefreshCw, Settings2 } from 'lucide-react';
import { fetchProviderKeys } from './api';
import { getSelectedProviderKeySelection, saveSelectedProviderKeySelection } from './provider-key-selection';
import type { ProviderKeyCard } from './types';

function ProviderKeysPage() {
  const isCompactWindow = new URLSearchParams(window.location.search).has('compact');
  const [cards, setCards] = useState<ProviderKeyCard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => getSelectedProviderKeySelection()?.providerKeyId ?? null);
  const [poolId, setPoolId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectionNotice, setSelectionNotice] = useState('');

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const pool = await fetchProviderKeys();
      const savedSelection = getSelectedProviderKeySelection();
      const selectionIsValid = savedSelection?.poolId === pool.poolId
        && pool.cards.some((card) => card.id === savedSelection.providerKeyId);
      setCards(pool.cards);
      setPoolId(pool.poolId);
      setSelectedId(selectionIsValid ? savedSelection.providerKeyId : null);
      if (!selectionIsValid && savedSelection) {
        saveSelectedProviderKeySelection(null);
        setSelectionNotice('卡池已更新，旧卡号已清除。请重新选择卡号或确认使用自动轮询。');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '卡池状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = '青叶科技 | API 卡池';
    const url = new URL(window.location.href);
    if (url.searchParams.has('selection_reset')) {
      saveSelectedProviderKeySelection(null);
      setSelectedId(null);
      setSelectionNotice('卡池已更新，旧卡号已清除。请重新选择卡号或确认使用自动轮询。');
      url.searchParams.delete('selection_reset');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    void loadCards();
  }, [loadCards]);

  const select = (providerKeyId: string | null) => {
    if (providerKeyId && !poolId) return;
    setSelectedId(providerKeyId);
    setSelectionNotice('');
    saveSelectedProviderKeySelection(providerKeyId ? { providerKeyId, poolId } : null);
  };

  const selectedCard = cards.find((card) => card.id === selectedId);
  const selectedCardCooling = (selectedCard?.cooldownSecondsRemaining ?? 0) > 0;

  return (
    <main className={`mirror-shell provider-keys-shell ${isCompactWindow ? 'compact-shell' : ''}`}>
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
          <button className="icon-button" type="button" onClick={() => void loadCards()} disabled={loading} aria-label="刷新卡池" title="刷新卡池">
            <RefreshCw size={17} />
          </button>
          <a className="secondary-button provider-manage-button" href="/cards/manage">
            <Settings2 size={15} />管理卡池
          </a>
          <a className="secondary-button provider-back-button" href={new URLSearchParams(window.location.search).has('compact') ? '/?compact=1' : '/'}>
            <ArrowLeft size={15} />返回试衣
          </a>
        </div>
      </header>

      <section className="provider-settings" aria-labelledby="provider-page-title">
        <div className="provider-page-heading">
          <span className="panel-kicker">PROVIDER ROUTING</span>
          <h2 id="provider-page-title">API 卡池</h2>
          <p>{loading ? '正在读取卡池状态' : `${cards.length} 张卡已配置`}</p>
        </div>

        <div className="provider-current-selection" role="status">
          <KeyRound size={16} />
          <span>{selectedId
            ? `下次会话：卡号 ${selectedCard?.number ?? '已失效'}${selectedCardCooling ? '（冷却中，请刷新或换卡）' : ''}`
            : '下次会话：自动轮询'}</span>
        </div>

        {error && <div className="error-ribbon" role="alert">{error}</div>}
        {selectionNotice && <p className="warning-note" role="status">{selectionNotice}</p>}
        {!loading && !error && (
          <div className="provider-choice-list" role="radiogroup" aria-label="选择试衣 API 卡">
            <button className={`provider-choice ${selectedId === null ? 'is-selected' : ''}`} type="button" role="radio" aria-checked={selectedId === null} onClick={() => select(null)}>
              <span className="provider-choice-icon"><CircleDashed size={18} /></span>
              <span className="provider-choice-copy"><strong>自动轮询</strong><small>按活跃会话数分配</small></span>
              {selectedId === null && <Check className="provider-choice-check" size={18} />}
            </button>
            {cards.map((card) => {
              const cooling = card.cooldownSecondsRemaining > 0;
              const selected = selectedId === card.id;
              return (
                <button
                  className={`provider-choice ${selected ? 'is-selected' : ''} ${cooling ? 'is-unavailable' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  key={card.id}
                  disabled={cooling}
                  onClick={() => select(card.id)}
                >
                  <span className="provider-card-number">{String(card.number).padStart(2, '0')}</span>
                  <span className="provider-choice-copy">
                    <strong>卡号 {card.number}</strong>
                    <small>{card.activeSessions > 0 ? `活跃会话 ${card.activeSessions}` : '空闲'}</small>
                  </span>
                  <span className={`provider-card-status ${cooling ? 'is-cooling' : ''}`}>
                    {cooling ? <><Clock3 size={13} />冷却 {card.cooldownSecondsRemaining}s</> : '可用'}
                  </span>
                  {selected && <Check className="provider-choice-check" size={18} />}
                </button>
              );
            })}
          </div>
        )}

        {!loading && !error && cards.length === 0 && <p className="provider-empty">尚未配置 API 卡</p>}
        <p className="provider-note">所选卡会持续用于后续新会话；运行中的会话不会热切换，需停止后重新启动。</p>
      </section>
    </main>
  );
}

export default ProviderKeysPage;
