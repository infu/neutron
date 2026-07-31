module {
  let record = { regionNew = 1 };
  let { regionNew = allocate } = record;
  public let use = allocate;
}
