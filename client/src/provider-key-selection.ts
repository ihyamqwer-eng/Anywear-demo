export const PROVIDER_KEY_SELECTION_STORAGE_KEY = 'anywear-selected-provider-key-id';

import type { ProviderKeySelection } from './types';

export function getSelectedProviderKeySelection(): ProviderKeySelection | undefined {
  try {
    const serialized = window.localStorage.getItem(PROVIDER_KEY_SELECTION_STORAGE_KEY);
    if (!serialized) return undefined;
    const selection = JSON.parse(serialized) as Partial<ProviderKeySelection>;
    if (typeof selection.providerKeyId === 'string' && typeof selection.poolId === 'string') return selection as ProviderKeySelection;
    window.localStorage.removeItem(PROVIDER_KEY_SELECTION_STORAGE_KEY);
    return undefined;
  } catch {
    try {
      window.localStorage.removeItem(PROVIDER_KEY_SELECTION_STORAGE_KEY);
    } catch {
      return undefined;
    }
    return undefined;
  }
}

export function saveSelectedProviderKeySelection(selection: ProviderKeySelection | null): void {
  try {
    if (selection) window.localStorage.setItem(PROVIDER_KEY_SELECTION_STORAGE_KEY, JSON.stringify(selection));
    else window.localStorage.removeItem(PROVIDER_KEY_SELECTION_STORAGE_KEY);
  } catch {
    // The API selector remains usable when browser storage is unavailable.
  }
}
