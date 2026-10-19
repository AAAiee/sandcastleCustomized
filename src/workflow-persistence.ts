import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";

// Callers own serialization/validation and error policy. No provider or observer
// can run until the complete replacement is durable and visible at the final path.
export function atomicReplace(path: string, bytes: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}
