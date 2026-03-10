import type { GitProviderRepository } from "../db/repositories.js";
import type { GitProviderRow } from "../types/domain.js";
import { JarvisGitBridgeError } from "./errors.js";

export class ProviderService {
  private readonly repository: GitProviderRepository;

  constructor(repository: GitProviderRepository) {
    this.repository = repository;
  }

  async register(params: {
    name: string;
    providerType: "gitea" | "github";
    baseUrl: string;
    ownerDefault: string;
    authType: "pat" | "ssh_key" | "basic";
    secretRef: string;
  }): Promise<{ providerId: number; status: "registered" }> {
    const provider = await this.repository.upsert({
      name: params.name,
      providerType: params.providerType,
      baseUrl: params.baseUrl,
      ownerDefault: params.ownerDefault,
      authType: params.authType,
      secretRef: params.secretRef,
    });

    return {
      providerId: provider.id,
      status: "registered",
    };
  }

  async requireProviderByName(name: string): Promise<GitProviderRow> {
    const provider = await this.repository.findByName(name);
    if (provider === null) {
      throw new JarvisGitBridgeError("PROVIDER_NOT_FOUND", "Provider not found");
    }

    return provider;
  }
}
