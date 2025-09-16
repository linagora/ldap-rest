#!/usr/bin/env node
"use strict";var e=require("http");console.log("Hello from Node.js server!"),console.log("Process arguments:",process.argv);const r=e.createServer((e,r)=>{r.writeHead(200,{"Content-Type":"text/plain"}),r.end("Hello World from TypeScript server!\n")}),o=process.env.PORT||3e3;r.listen(o,()=>{console.log(`Server running on port ${o}`)});
//# sourceMappingURL=server.js.map
