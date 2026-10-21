'use strict';

// Explicit launcher for the previously authorized, isolated App test thread.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {startPrototype} = require('./server');
const threadId = process.argv[2];
if (!threadId || !/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw new Error('Pass the isolated App test thread ID.');
const questionId = `app-question-${randomUUID()}`;
startPrototype({port:18792,toolBinding:{questionId,threadId}}).then(service=>{
  const bindingFile = path.join(service.directory,'mcp-binding.json');
  const binding = {baseUrl:service.baseUrl,toolToken:service.toolToken,threadId,questionId,traceFile:path.join(service.directory,'mcp-trace.jsonl')};
  fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2),{mode:0o600});
  console.log(JSON.stringify({baseUrl:service.baseUrl,directory:service.directory,bindingFile,questionId:binding.questionId,threadId,
    desktopUrl:`${service.baseUrl}/?client=desktop#key=${service.token}`,phoneUrl:`${service.baseUrl}/?client=phone#key=${service.token}`}));
  let closing=false;
  const stop=()=>{if(!closing){closing=true;service.close().then(()=>process.exit(0));}};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}).catch(error=>{console.error(error.message);process.exitCode=1;});
