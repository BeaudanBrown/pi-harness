import { createManagedSessionAdapterExtension } from "./extension.js";

export const managedSessionAdapterProfile = "coordinator_adapter" as const;
export default createManagedSessionAdapterExtension(managedSessionAdapterProfile);
