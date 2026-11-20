import fs from 'node:fs';
async function download(url, out) {
  const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log('saved', out, (buf.length/1048576).toFixed(1) + 'MB');
}
await download('https://dl.google.com/android/repository/platform-34-ext7_r03.zip', 'platform-34.zip');
const meta = await (await fetch('https://maven.aliyun.com/repository/google/com/android/tools/r8/maven-metadata.xml')).text();
const versions = [...meta.matchAll(/<version>([\d.]+)<\/version>/g)].map(m => m[1]);
const stable = versions.filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a,b) => {
  const A=a.split('.').map(Number), B=b.split('.').map(Number);
  for (let i=0;i<3;i++) if (A[i]!==B[i]) return A[i]-B[i];
  return 0;
});
const v = stable[stable.length-1];
console.log('r8 version', v);
await download(`https://maven.aliyun.com/repository/google/com/android/tools/r8/${v}/r8-${v}.jar`, 'r8.jar');
