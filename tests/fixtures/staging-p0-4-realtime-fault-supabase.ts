type RealtimeStatus = 'SUBSCRIBED' | 'CLOSED';

interface FakeRealtimeState {
  channelsCreated: number;
  channelsRemoved: number;
  activeChannels: number;
  deliveredEvents: number;
  queries: string[];
  rows: Record<string, Array<Record<string, unknown>>>;
  emit: (table: string, payload: Record<string, unknown>) => void;
  snapshot: () => Record<string, unknown>;
}

class FakeChannel {
  private handlers: Array<{ table: string; callback: (payload: Record<string, unknown>) => void }> = [];
  private statusCallback: ((status: RealtimeStatus) => void) | null = null;
  subscribed = false;

  constructor(private readonly state: FakeRealtimeState) {}

  on(_kind: string, filter: { table: string }, callback: (payload: Record<string, unknown>) => void) {
    this.handlers.push({ table: filter.table, callback });
    return this;
  }

  subscribe(callback: (status: RealtimeStatus) => void) {
    this.statusCallback = callback;
    queueMicrotask(() => {
      this.subscribed = true;
      this.state.activeChannels += 1;
      callback('SUBSCRIBED');
    });
    return this;
  }

  deliver(table: string, payload: Record<string, unknown>) {
    if (!this.subscribed) return;
    for (const handler of this.handlers) {
      if (handler.table !== table) continue;
      this.state.deliveredEvents += 1;
      handler.callback(payload);
    }
  }

  close() {
    if (!this.subscribed) return;
    this.subscribed = false;
    this.state.activeChannels -= 1;
    this.statusCallback?.('CLOSED');
  }
}

const channels = new Set<FakeChannel>();
const state: FakeRealtimeState = {
  channelsCreated: 0,
  channelsRemoved: 0,
  activeChannels: 0,
  deliveredEvents: 0,
  queries: [],
  rows: { purchase_batches: [], purchase_batch_items: [] },
  emit(table, payload) {
    channels.forEach(channel => channel.deliver(table, payload));
  },
  snapshot() {
    return {
      channelsCreated: this.channelsCreated,
      channelsRemoved: this.channelsRemoved,
      activeChannels: this.activeChannels,
      deliveredEvents: this.deliveredEvents,
      queries: [...this.queries],
    };
  },
};

declare global {
  interface Window {
    __P0_4_REALTIME_FAKE__: FakeRealtimeState;
  }
}

window.__P0_4_REALTIME_FAKE__ = state;

const queryFor = (table: string) => {
  const builder = {
    select() { return builder; },
    abortSignal() { return builder; },
    in() { return builder; },
    gt() { return builder; },
    order() { return builder; },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      state.queries.push(table);
      return Promise.resolve({ data: structuredClone(state.rows[table] ?? []), error: null }).then(resolve, reject);
    },
  };
  return builder;
};

export const supabaseEnvironment = {
  projectRef: 'rhfdjsklfrgpoqsaqpkn',
  role: 'experimental' as const,
};

export const supabase = {
  channel() {
    state.channelsCreated += 1;
    const channel = new FakeChannel(state);
    channels.add(channel);
    return channel;
  },
  async removeChannel(channel: FakeChannel) {
    state.channelsRemoved += 1;
    channel.close();
    channels.delete(channel);
    return 'ok';
  },
  from(table: string) {
    return queryFor(table);
  },
  async rpc() {
    return { data: null, error: null };
  },
};

export const supabaseAuthStorageKey = null;
export const initialSupabaseAuthStorageState = 'none';
export const hasStoredSupabaseAuthToken = () => false;
export const clearStoredSupabaseAuthToken = () => {};
