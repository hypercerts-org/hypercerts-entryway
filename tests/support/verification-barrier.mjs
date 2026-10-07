// Test-owned instrumentation pauses after the supported adapter transaction has
// returned a consumed verification. It changes no provider or persistence code.
export function pauseVerificationConsumption(db, pause) {
  let paused = false;
  return {
    ...db,
    authenticationAdapter(options) {
      const adapter = db.authenticationAdapter(options);
      return new Proxy(adapter, {
        get(target, property, receiver) {
          if (property !== "transaction")
            return Reflect.get(target, property, receiver);
          return async (operation) => {
            const result = await adapter.transaction(operation);
            if (
              !paused &&
              result?.identifier?.startsWith("sign-in-otp-") &&
              result.value
            ) {
              paused = true;
              await pause();
            }
            return result;
          };
        },
      });
    },
  };
}
