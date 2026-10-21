'use strict';
// Local fixture only; the known token is never used by the regular launcher.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startPrototype } = require('./server');

startPrototype({ port:18791, token:'isolated-question-e2e-key-v1', directory:process.argv[2] }).then(service => {
  const consumer = process.argv[2] ? null : spawn(process.execPath,[path.join(__dirname,'ask.js')],{stdio:['pipe','pipe','inherit'],windowsHide:true});
  let output = '';
  consumer?.stdout.on('data',data=>{ output += data; });
  consumer?.stdin.end(JSON.stringify({ baseUrl:service.baseUrl,token:service.token,question:{id:'consumer',threadId:'browser-e2e',prompt:'请选择或自行填写回复。\n第二行：保留换行 <beta>',options:[{label:'确认一次',description:'采用当前方案。'},{label:'保留原值',description:'暂时保持现状。'}]} }));
  consumer?.on('exit',code=>{
    fs.writeFileSync(path.join(service.directory,'consumer-result.json'),JSON.stringify({code,lines:output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))},null,2));
    console.log(`Consumer exited: ${code}; result lines: ${output.trim().split('\n').filter(Boolean).length}`);
  });
  console.log(JSON.stringify({ baseUrl:service.baseUrl, directory:service.directory, pid:process.pid }));
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; if (consumer?.exitCode === null) consumer.kill(); await service.close(); process.exit(0); };
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}).catch(error=>{console.error(error);process.exitCode=1;});
