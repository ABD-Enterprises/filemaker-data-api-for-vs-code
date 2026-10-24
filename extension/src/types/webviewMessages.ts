export interface WebviewMessageEnvelope<TType extends string = string> {
  type: TType;
  payload?: unknown;
}

export interface WebviewErrorPayload {
  message: string;
}

export type CommonOutboundMessage<TType extends string, TPayload> = {
  type: TType;
  payload: TPayload;
};

export interface QueryBuilderRunPayload {
  profileId: string;
  layout: string;
  findJson: string;
  sortJson?: string;
  limit?: number;
  offset?: number;
  queryId?: string;
}
