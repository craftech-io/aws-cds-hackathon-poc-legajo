// SST builds a role's policy from each permission's `resources` as a list: one Output that holds the
// whole array reaches IAM as a statement with no Resource ("Policy statement must contain resources",
// first deploy of poc). Every ARN therefore goes as its own element, an Output or a string; the count is
// known at plan time (a placeholder gives the shape) and checked again when the Output resolves.
export function splitOutput(list: $util.Output<readonly string[]>, count: number): $util.Output<string>[] {
  return Array.from({ length: count }, (_, index) =>
    list.apply((items) => {
      const item = items[index];
      if (items.length !== count || item === undefined) throw new Error(`expected ${count} ARN(s) in the statement, got ${items.length}`);
      return item;
    }),
  );
}
