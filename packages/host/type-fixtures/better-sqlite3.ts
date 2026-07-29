export class Database {
  prepare(_sql: string) {
    return { run: (..._args: unknown[]) => undefined, get: () => undefined, all: () => [] };
  }
  pragma(_sql: string) {}
  exec(_sql: string) {}
  close() {}
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return fn;
  }
}

export default Database;
