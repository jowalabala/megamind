// Postgres LISTEN/NOTIFY, for fanning real-time events out across service instances.
// Payloads carry ids only: the channel is shared by every tenant.
import pg from "pg";

export interface Listener {
  close(): Promise<void>;
}

/** Listens on a channel with its own connection, reconnecting if it drops. */
export async function listen(
  options: {
    connectionString: string;
    ssl?: pg.ClientConfig["ssl"];
    onError?: (err: Error) => void;
  },
  channel: string,
  onMessage: (payload: string) => void,
): Promise<Listener> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) throw new Error("Invalid channel name");
  let client: pg.Client | null = null;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const connect = async () => {
    const c = new pg.Client({ connectionString: options.connectionString, ssl: options.ssl });
    c.on("notification", (n) => {
      if (n.channel === channel && n.payload) onMessage(n.payload);
    });
    c.on("error", (err) => {
      options.onError?.(err);
      if (!closed) {
        client = null;
        retry = setTimeout(() => void connect().catch(() => {}), 2_000);
      }
    });
    await c.connect();
    await c.query(`LISTEN ${channel}`);
    client = c;
  };
  await connect();
  return {
    async close() {
      closed = true;
      clearTimeout(retry);
      await client?.end().catch(() => {});
    },
  };
}
