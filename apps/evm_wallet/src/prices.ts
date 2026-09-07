import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { parseEvmPricesRequest, parseEvmPricesResult } from "neutron-tools/evm_wallet";
import { createEvmUsdPriceCache } from "neutron-tools/src/evm_prices.js";

// The resident browser service shares this volatile cache between Wallet,
// Uniswap and agent callers. No timer or network request runs until a tool call.
const cache = createEvmUsdPriceCache();

export async function prices(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const request = parseEvmPricesRequest(args);
  const result = await cache.getPrices(request.assets, context.signal ? { signal: context.signal } : {});
  context.signal?.throwIfAborted();
  return parseEvmPricesResult(result, request) as unknown as JsonObject;
}
