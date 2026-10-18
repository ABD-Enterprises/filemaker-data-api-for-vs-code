export interface RuntimeRecord {
  recordId: string;
  modId?: string;
  fieldData: Record<string, unknown>;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface RuntimeFindRequest {
  layout: string;
  query: Array<Record<string, unknown>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface RuntimeFindResponse {
  data: RuntimeRecord[];
  dataInfo?: Record<string, unknown>;
}

export interface RuntimeEditResponse {
  recordId: string;
  modId?: string;
  response: Record<string, unknown>;
}

export interface RuntimeRunScriptResponse {
  response: Record<string, unknown>;
  messages: Array<{ code: string; message: string }>;
}

export class RuntimeBridgeClient {
  public constructor(private readonly baseUrl?: string, private readonly fetchFn: typeof fetch = fetch) {}

  public isConfigured(): boolean {
    return Boolean(normalizeBridgeBaseUrl(this.baseUrl));
  }

  public async find(request: RuntimeFindRequest): Promise<RuntimeFindResponse> {
    return this.post<RuntimeFindResponse>('find', request);
  }

  public async getRecord(layout: string, recordId: string): Promise<RuntimeRecord> {
    return this.post<RuntimeRecord>('getRecord', { layout, recordId });
  }

  public async editRecord(
    layout: string,
    recordId: string,
    fieldData: Record<string, unknown>
  ): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('editRecord', { layout, recordId, fieldData });
  }

  public async createRecord(layout: string, fieldData: Record<string, unknown>): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('createRecord', { layout, fieldData });
  }

  public async deleteRecord(layout: string, recordId: string): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('deleteRecord', { layout, recordId });
  }

  public async runScript(request: {
    layout: string;
    scriptName: string;
    scriptParam?: string;
    recordId?: string;
  }): Promise<RuntimeRunScriptResponse> {
    return this.post<RuntimeRunScriptResponse>('runScript', request);
  }

  private async post<T>(route: string, payload: unknown): Promise<T> {
    const normalizedBaseUrl = normalizeBridgeBaseUrl(this.baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error('Bridge URL is not configured.');
    }

    const response = await this.fetchFn(`${normalizedBaseUrl}/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await parseResponse(response);
    if (!response.ok) {
      const message = body && typeof body === 'object' ? String((body as { error?: string }).error ?? '') : '';
      throw new Error(message || `Bridge request failed with status ${response.status}.`);
    }

    return body as T;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: text
    };
  }
}

export function normalizeBridgeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, '');
}
