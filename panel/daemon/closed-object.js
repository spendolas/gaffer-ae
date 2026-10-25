// Keeps the tools/list input schemas closed under zod 4.
//
// zod 3 (through zod-to-json-schema) advertised every z.object as
// "additionalProperties": false. zod 4's own JSON Schema output, which the MCP
// SDK uses for zod 4 schemas (toJSONSchema with io: 'input'), leaves the key
// off a plain z.object, so clients would see open objects. closedObject puts
// it back as schema metadata: only the advertised JSON Schema changes, runtime
// validation still strips unknown keys exactly as before (z.strictObject would
// reject them instead, a behaviour change).

export function closedObject(z, shape) {
  return z.object(shape).meta({ additionalProperties: false });
}

// Every tool passes its inputSchema as a raw shape, which the SDK turns into a
// plain (open) object. Wrap registerTool so each raw shape becomes a closed
// object first; an inputSchema that is already a zod schema is left alone.
export function closeToolInputs(server, z) {
  var register = server.registerTool.bind(server);
  server.registerTool = function (name, config, cb) {
    if (config && config.inputSchema && !(config.inputSchema instanceof z.ZodType)) {
      config = Object.assign({}, config, { inputSchema: closedObject(z, config.inputSchema) });
    }
    return register(name, config, cb);
  };
  return server;
}
