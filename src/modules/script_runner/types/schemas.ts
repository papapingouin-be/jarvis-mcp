import { z } from "zod";

export const scriptPhaseSchema = z.enum(["collect", "execute"]);
export const scriptParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const jarvisRunScriptInputSchema = z.object({
  script_name: z.string().min(1).max(128),
  phase: scriptPhaseSchema,
  confirmed: z.boolean().optional(),
  verbose: z.boolean().optional().default(true),
  params: z.record(z.string(), scriptParamValueSchema).optional(),
});

export type JarvisRunScriptInput = z.infer<typeof jarvisRunScriptInputSchema>;
