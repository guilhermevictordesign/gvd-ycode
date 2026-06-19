/**
 * Globals Store
 *
 * Global state for site-wide global variables (typed Name / Type / Value
 * singletons). Provides load + optimistic CRUD used by the CMS Globals
 * manager and the data-injection dropdown.
 */

import { create } from 'zustand';
import { globalVariablesApi } from '@/lib/api';
import type {
  GlobalVariable,
  CreateGlobalVariableData,
  UpdateGlobalVariableData,
} from '@/types';

interface GlobalsState {
  globals: GlobalVariable[];
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
}

interface GlobalsActions {
  loadGlobals: () => Promise<void>;
  createGlobal: (data: CreateGlobalVariableData) => Promise<GlobalVariable | null>;
  updateGlobal: (id: string, data: UpdateGlobalVariableData) => Promise<GlobalVariable | null>;
  deleteGlobal: (id: string) => Promise<boolean>;
  getGlobalById: (id: string) => GlobalVariable | undefined;
}

type GlobalsStore = GlobalsState & GlobalsActions;

export const useGlobalsStore = create<GlobalsStore>((set, get) => ({
  globals: [],
  isLoading: false,
  hasLoaded: false,
  error: null,

  loadGlobals: async () => {
    set({ isLoading: true, error: null });

    try {
      const response = await globalVariablesApi.getAll();

      if (response.error) {
        throw new Error(response.error);
      }

      set({ globals: response.data || [], isLoading: false, hasLoaded: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load global variables';
      set({ error: message, isLoading: false });
    }
  },

  createGlobal: async (data) => {
    try {
      const response = await globalVariablesApi.create(data);

      if (response.error) {
        set({ error: response.error });
        return null;
      }

      if (response.data) {
        set((state) => ({ globals: [...state.globals, response.data!] }));
        return response.data;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create global variable';
      set({ error: message });
      return null;
    }
  },

  updateGlobal: async (id, data) => {
    try {
      const response = await globalVariablesApi.update(id, data);

      if (response.error) {
        set({ error: response.error });
        return null;
      }

      if (response.data) {
        set((state) => ({
          globals: state.globals.map((g) => (g.id === id ? response.data! : g)),
        }));
        return response.data;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update global variable';
      set({ error: message });
      return null;
    }
  },

  deleteGlobal: async (id) => {
    try {
      const response = await globalVariablesApi.delete(id);

      if (response.error) {
        set({ error: response.error });
        return false;
      }

      set((state) => ({ globals: state.globals.filter((g) => g.id !== id) }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete global variable';
      set({ error: message });
      return false;
    }
  },

  getGlobalById: (id) => {
    return get().globals.find((g) => g.id === id);
  },
}));
