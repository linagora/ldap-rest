#!/usr/bin/env node
"use strict";const e=require("http").createServer((e,r)=>{r.writeHead(200,{"Content-Type":"text/plain"}),r.end("Hello World from TypeScript server!\n")}),r=process.env.PORT||3e3;e.listen(r,()=>{console.log(`Server running on port ${r}`)});
//# sourceMappingURL=server.js.map
