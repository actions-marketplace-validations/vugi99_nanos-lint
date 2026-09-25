-- Shared script: the side check is deliberate and must not be reported.
if Package.IsUnloading() then
  return
end

Server.ChangeMap("guarded-map")
Events.Call("bridge-ready")
