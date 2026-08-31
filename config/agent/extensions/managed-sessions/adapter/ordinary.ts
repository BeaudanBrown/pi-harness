import { createManagedSessionAdapterExtension } from "./extension.js";

export const managedSessionAdapterProfile = "ordinary_adapter" as const;
export default createManagedSessionAdapterExtension(managedSessionAdapterProfile);
