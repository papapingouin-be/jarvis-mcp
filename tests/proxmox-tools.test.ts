import assert from "node:assert";
import { describe, it } from "node:test";
import { extractCtList } from "../src/tools/proxmox.ts";
import { withTestClient } from "./helpers/test-client.ts";

describe("Proxmox Tools", () => {
  it("should list dedicated proxmox tools", async () => {
    await withTestClient(async (client) => {
      const response = await client.listTools();
      const toolNames = response.tools.map((tool) => tool.name);

      assert(toolNames.includes("proxmox_list_cts"), "proxmox_list_cts should be listed");
      assert(toolNames.includes("proxmox_create_ct"), "proxmox_create_ct should be listed");

      const listTool = response.tools.find((tool) => tool.name === "proxmox_list_cts");
      const createTool = response.tools.find((tool) => tool.name === "proxmox_create_ct");

      assert.strictEqual(
        listTool?.description,
        "List Proxmox LXC CT containers. Use this when the user asks to list CTs, LXC containers, or containers on Proxmox."
      );
      assert.strictEqual(
        createTool?.description,
        "Create and start a new Proxmox LXC CT container. Use this when the user asks to create a CT, create an LXC, or create a container on Proxmox."
      );
    });
  });

  it("should keep only CT entries from a guest inventory payload", () => {
    const cts = extractCtList({
      result: {
        guests: [
          { type: "ct", vmid: "101", status: "running", name: "web-101" },
          { type: "vm", vmid: "201", status: "running", name: "vm-201" },
          { type: "ct", vmid: "102", status: "stopped", name: "db-102" },
        ],
      },
    });

    assert.deepStrictEqual(cts, [
      { type: "ct", vmid: "101", status: "running", name: "web-101" },
      { type: "ct", vmid: "102", status: "stopped", name: "db-102" },
    ]);
  });
});
