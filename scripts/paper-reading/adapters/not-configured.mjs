export function notConfiguredSourceStatus({ id, interfaceName, nextStep }) {
  return {
    records: [],
    status: {
      id,
      implementation: "adapter-interface",
      interfaceName,
      mode: "not-configured",
      status: "not-configured",
      live: false,
      requestCount: 0,
      fetchedEntryCount: 0,
      inWindowEntryCount: 0,
      queries: [],
      nextStep,
    },
  };
}
