export async function awaitQualificationPrerequisites<
  const Values extends readonly unknown[],
>(
  promises: { [Index in keyof Values]: Promise<Values[Index]> },
): Promise<Values> {
  const settled = await Promise.allSettled(promises);
  return qualificationValues(
    settled,
    "Certified Assets qualification prerequisites failed",
  ) as unknown as Values;
}

export async function runBoundedQualificationWorkset<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  execute: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(
      "Certified Assets qualification concurrency must be a positive safe integer",
    );
  }
  const settled = new Array<PromiseSettledResult<Output>>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          settled[index] = {
            status: "fulfilled",
            value: await Promise.resolve().then(() =>
              execute(inputs[index]!, index)
            ),
          };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return qualificationValues(
    settled,
    "Certified Assets qualification workset failed",
  );
}

function qualificationValues<Value>(
  settled: readonly PromiseSettledResult<Value>[],
  aggregateMessage: string,
): Value[] {
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      aggregateMessage,
    );
  }
  return settled.map((result) => {
    if (result.status !== "fulfilled") {
      throw new Error(
        "Certified Assets qualification item did not settle",
      );
    }
    return result.value;
  });
}
