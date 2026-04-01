import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ScriptRunnerService } from "../modules/script_runner/services/script-runner.js";
import { asScriptRunnerError } from "../modules/script_runner/services/errors.js";
import type { RegisterableModule } from "../registry/types.js";

const PROXMOX_SCRIPT_NAME = "proxmox-diagnose.sh";
const service = new ScriptRunnerService();

const connectionFields = {
  host: z.string().trim().min(1).describe("Proxmox host or IP address."),
  user: z.string().trim().min(1).describe("SSH user for the Proxmox host."),
  password: z.string().trim().min(1).optional().describe(
    "Optional SSH password. Also used as the CT root password for create-ct when no separate secret exists."
  ),
  port: z.string().trim().min(1).optional().describe("SSH port. Defaults to 22."),
  sudo: z.boolean().optional().default(true).describe("Run Proxmox commands through sudo when needed."),
  identity_file: z.string().trim().min(1).optional().describe("Optional SSH private key path."),
  verbose: z.boolean().optional().default(true).describe("Include execution trace lines in the result."),
  trace: z.boolean().optional().default(false).describe("Ask the underlying Proxmox script for extra tracing."),
};

const listCtsInputSchema = {
  ...connectionFields,
};

const createCtInputSchema = {
  ...connectionFields,
  vmid: z.string().trim().min(1).describe("CT VMID to create."),
  hostname: z.string().trim().min(1).describe("Hostname for the new CT."),
  template: z.string().trim().min(1).describe("Template archive name, for example debian-12-standard_12.7-1_amd64.tar.zst."),
  storage: z.string().trim().min(1).describe("Target Proxmox storage, for example local-lvm."),
  bridge: z.string().trim().min(1).describe("Network bridge, for example vmbr0."),
  cores: z.string().trim().min(1).optional().describe("CPU cores. Defaults to 2."),
  memory: z.string().trim().min(1).optional().describe("Memory in MB. Defaults to 2048."),
  swap: z.string().trim().min(1).optional().describe("Swap in MB. Defaults to 512."),
  disk: z.string().trim().min(1).optional().describe("Disk size in GB. Defaults to 8."),
  install_ssh: z.boolean().optional().default(true).describe("Install and enable OpenSSH inside the CT after creation."),
  confirmed: z.boolean().optional().default(false).describe("Must be true to actually create the CT."),
};

type BaseConnectionArgs = {
  host: string;
  user: string;
  password?: string;
  port?: string;
  sudo?: boolean;
  identity_file?: string;
  verbose?: boolean;
  trace?: boolean;
};

function toErrorResponse(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const safeError = asScriptRunnerError(error);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            code: safeError.code,
            message: safeError.safeMessage,
            context: safeError.context ?? {},
          },
        }),
      },
    ],
  };
}

function normalizeParamValue(value: string | number | boolean | undefined): string | number | boolean | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}

function compactParams(
  params: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) => {
      const normalized = normalizeParamValue(value);
      return normalized === undefined ? [] : [[key, normalized]];
    })
  ) as Record<string, string | number | boolean>;
}

function buildBaseParams(args: BaseConnectionArgs, mode: string): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean | undefined> = {
    mode,
    host: args.host,
    user: args.user,
    password: args.password,
    port: args.port,
    sudo: args.sudo,
    identity_file: args.identity_file,
    trace: args.trace,
  };

  return compactParams(params);
}

export function extractCtList(rawResult: Record<string, unknown>): Array<Record<string, unknown>> {
  const nestedResult = rawResult.result;
  if (typeof nestedResult !== "object" || nestedResult === null || Array.isArray(nestedResult)) {
    return [];
  }

  const guests = (nestedResult as { guests?: unknown }).guests;
  if (!Array.isArray(guests)) {
    return [];
  }

  return guests
    .filter((guest): guest is Record<string, unknown> => typeof guest === "object" && guest !== null && !Array.isArray(guest))
    .filter((guest) => guest.type === "ct");
}

function buildCtSummary(rawResult: Record<string, unknown>): Record<string, unknown> {
  const nestedResult = rawResult.result;
  if (typeof nestedResult !== "object" || nestedResult === null || Array.isArray(nestedResult)) {
    return {};
  }

  const objectResult = nestedResult as Record<string, unknown>;
  return {
    vmid: objectResult.vmid ?? null,
    hostname: objectResult.hostname ?? null,
    ipv4: objectResult.ipv4 ?? objectResult.detected_ipv4 ?? null,
    status: objectResult.status ?? null,
  };
}

export function registerProxmoxTools(server: McpServer): void {
  server.tool(
    "proxmox_list_cts",
    "List Proxmox LXC CT containers. Use this when the user asks to list CTs, LXC containers, or containers on Proxmox.",
    listCtsInputSchema,
    async (args) => {
      try {
        const rawResult = await service.run({
          script_name: PROXMOX_SCRIPT_NAME,
          phase: "collect",
          confirmed: false,
          verbose: args.verbose,
          params: buildBaseParams(args, "list-guests"),
        });

        const cts = extractCtList(rawResult.result);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "list-cts",
                count: cts.length,
                cts,
                summary: rawResult.result.summary ?? null,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return toErrorResponse(error);
      }
    }
  );

  server.tool(
    "proxmox_create_ct",
    "Create and start a new Proxmox LXC CT container. Use this when the user asks to create a CT, create an LXC, or create a container on Proxmox.",
    createCtInputSchema,
    async (args) => {
      try {
        const rawResult = await service.run({
          script_name: PROXMOX_SCRIPT_NAME,
          phase: "execute",
          confirmed: args.confirmed,
          verbose: args.verbose,
          params: compactParams({
            ...buildBaseParams(args, "create-ct"),
            vmid: args.vmid,
            hostname: args.hostname,
            template: args.template,
            storage: args.storage,
            bridge: args.bridge,
            type: "ct",
            cores: args.cores,
            memory: args.memory,
            swap: args.swap,
            disk: args.disk,
            install_ssh: args.install_ssh,
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "create-ct",
                ct: buildCtSummary(rawResult.result),
                result: rawResult.result,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return toErrorResponse(error);
      }
    }
  );
}

const proxmoxModule: RegisterableModule = {
  type: "tool",
  name: "proxmox",
  description: "Dedicated Proxmox CT tools for natural list/create workflows.",
  register(server: McpServer) {
    registerProxmoxTools(server);
  },
};

export default proxmoxModule;
