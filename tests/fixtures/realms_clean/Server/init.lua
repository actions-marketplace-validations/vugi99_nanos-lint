-- Shared globals stay visible in every realm pass.
print(SharedConfig.retries)

Server.ChangeMap("some-map")
Timer.SetTimeout(function()
  print("server tick")
end, 1000)
