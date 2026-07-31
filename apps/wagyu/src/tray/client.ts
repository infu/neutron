import {
  createMsgBusClient,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  WAGYU_RESIDENT_ENDPOINT,
  WAGYU_RESIDENT_TOOLS,
} from "../resident/contracts.ts";
import type { WagyuResidentSnapshot } from "../resident/orchestrator.ts";
import { parseResidentSnapshot } from "../resident/wire.ts";

const CALL_TIMEOUT_SECONDS = 20;

export class WagyuResidentClient {
  private readonly bus = createMsgBusClient();

  constructor(
    private readonly endpoint: MsgBusEndpointId =
      WAGYU_RESIDENT_ENDPOINT as MsgBusEndpointId,
  ) {}

  async snapshot(): Promise<WagyuResidentSnapshot> {
    return this.call(WAGYU_RESIDENT_TOOLS.snapshot, {});
  }

  async refresh(): Promise<WagyuResidentSnapshot> {
    return this.call(WAGYU_RESIDENT_TOOLS.refresh, {});
  }

  async wake(): Promise<WagyuResidentSnapshot> {
    return this.call(WAGYU_RESIDENT_TOOLS.wake, {});
  }

  async drain(): Promise<WagyuResidentSnapshot> {
    return this.call(WAGYU_RESIDENT_TOOLS.drain, {});
  }

  async retry(localSequence: string): Promise<WagyuResidentSnapshot> {
    if (!/^[1-9][0-9]{0,19}$/u.test(localSequence)) {
      throw new Error("Wagyu outbox local sequence is invalid");
    }
    return this.call(WAGYU_RESIDENT_TOOLS.retry, { localSequence });
  }

  async setAutoDrain(enabled: boolean): Promise<WagyuResidentSnapshot> {
    return this.call(WAGYU_RESIDENT_TOOLS.setAutoDrain, { enabled });
  }

  private async call(
    name: string,
    arguments_: Record<string, JsonValue>,
  ): Promise<WagyuResidentSnapshot> {
    return parseResidentSnapshot(
      await this.bus.callTool<JsonValue>(
        {
          target: this.endpoint,
          name,
          arguments: arguments_,
        },
        CALL_TIMEOUT_SECONDS,
      ),
    );
  }
}
