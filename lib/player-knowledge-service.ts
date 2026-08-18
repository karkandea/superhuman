import { normalizeManualKnowledge, type ManualKnowledgeInput } from './player-knowledge'

interface RpcResult<T> {
  data: T | null
  error: { message: string; code?: string } | null
}

export interface KnowledgeRpcClient {
  rpc<T = unknown>(
    functionName: string,
    params: Record<string, unknown>,
  ): PromiseLike<RpcResult<T>>
}

export async function ingestManualKnowledge(
  client: KnowledgeRpcClient,
  input: ManualKnowledgeInput,
): Promise<string> {
  const normalized = normalizeManualKnowledge(input)

  const { data, error } = await client.rpc<string>('ingest_manual_knowledge', {
    p_entry_type: normalized.entryType,
    p_raw_text: normalized.text,
    p_title: normalized.title,
    p_occurred_at: normalized.occurredAt,
    p_metadata: normalized.metadata,
  })

  if (error) throw new Error(error.message)
  if (typeof data !== 'string' || !data) throw new Error('Knowledge ingestion did not return an entry ID')

  return data
}
