import { AxiosHeaders, type AxiosResponse } from 'axios';

export function createAxiosResponse<T>(response: Pick<AxiosResponse<T>, 'data'>): AxiosResponse<T> {
  return {
    ...response,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() }
  };
}

export class InMemoryMemento {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.values.has(key)) {
      return defaultValue;
    }

    return this.values.get(key) as T;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }

    this.values.set(key, value);
  }
}

export class InMemorySecretStorage {
  private readonly values = new Map<string, string>();

  public async storeSecret(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  public async store(key: string, value: string): Promise<void> {
    await this.storeSecret(key, value);
  }
}
