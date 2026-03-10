import type { GitAuditLogRepository } from "../db/repositories.js";

export class AuditLogService {
  private readonly repository: GitAuditLogRepository;

  constructor(repository: GitAuditLogRepository) {
    this.repository = repository;
  }

  async record(params: {
    toolName: string;
    action: string;
    status: "ok" | "error";
    message: string;
    context: Record<string, unknown>;
  }): Promise<void> {
    await this.repository.create({
      toolName: params.toolName,
      action: params.action,
      status: params.status,
      message: params.message,
      context: params.context,
    });
  }

  async list(limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.repository.list(limit);

    return rows.map((row) => ({
      id: row.id,
      tool_name: row.tool_name,
      action: row.action,
      status: row.status,
      message: row.message,
      context_json: row.context_json,
      created_at: row.created_at,
    }));
  }
}
