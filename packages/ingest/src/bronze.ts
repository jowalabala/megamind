// Bronze: raw payloads exactly as received, kept 30 days (bucket lifecycle) so tasks can be
// reprocessed when redaction improves. Encrypted with KMS; only the ingest worker reads it.
// Keys are partitioned by tenant so one tenant's raw data can be deleted on its own.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type BronzeKind = "task" | "outcome" | "actions";

export interface BronzeStore {
  put(key: string, body: unknown): Promise<void>;
  /** Null when the object is gone (expired or deleted). */
  get(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function bronzeKey(tenantId: string, kind: BronzeKind, id: string, at: Date): string {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(id)) throw new Error("Invalid bronze key parts");
  return `raw/tenant=${tenantId}/kind=${kind}/dt=${at.toISOString().slice(0, 10)}/${id}.json`;
}

export function s3Bronze(options: {
  bucket: string;
  client?: S3Client;
  region?: string;
}): BronzeStore {
  const s3 = options.client ?? new S3Client({ region: options.region });
  return {
    async put(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: JSON.stringify(body),
          ContentType: "application/json",
          // The bucket's default key is the KMS key; this makes the intent explicit.
          ServerSideEncryption: "aws:kms",
        }),
      );
    },
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
        return JSON.parse(await res.Body!.transformToString("utf8"));
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}

/** Local development only: plain files under a directory that is git-ignored. */
export function fileBronze(dir: string): BronzeStore {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(root + "/")) throw new Error("Bronze key escapes the store");
    return p;
  };
  return {
    async put(key, body) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(body), { mode: 0o600 });
    },
    async get(key) {
      try {
        return JSON.parse(await readFile(pathFor(key), "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export function memoryBronze(): BronzeStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, JSON.stringify(body));
    },
    async get(key) {
      const v = objects.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
