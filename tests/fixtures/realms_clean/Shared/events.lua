Events.Call("package-ready")

if Package.IsUnloading() then
  return
end

Server.ChangeMap("guarded-map")
