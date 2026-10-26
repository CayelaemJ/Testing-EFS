import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

for (const page of ["login","set-password"]) {
  const html=readFileSync(new URL("../public/"+page+".html",import.meta.url),"utf8");
  const forms=[...html.matchAll(/<\/?form\b[^>]*>/gi)];
  const formIds=new Set([...html.matchAll(/<form\b[^>]*\bid=["']([^"']+)["']/gi)].map(m=>m[1]));
  const passwordInputs=[...html.matchAll(/<input\b[^>]*\btype=["']password["'][^>]*>/gi)];
  assert.ok(passwordInputs.length>0,page+" must contain a password input");
  for(const field of passwordInputs){
    const target=field[0].match(/\bform=["']([^"']+)["']/i)?.[1];
    if(target){assert.ok(formIds.has(target),page+": referenced form does not exist");continue;}
    let inForm=false;
    for(const boundary of forms){if(boundary.index>=field.index)break;inForm=!/^<\/form/i.test(boundary[0]);}
    assert.ok(inForm,page+": password field outside its form");
  }
  assert.equal(forms.filter(x=>/^<form/i.test(x[0])).length,forms.filter(x=>/^<\/form/i.test(x[0])).length,page+": unbalanced forms");
}
const login=readFileSync(new URL("../public/login.html",import.meta.url),"utf8");
assert.match(login,/onsubmit="event\.preventDefault\(\);signIn\(\)"/);
assert.match(login,/onsubmit="event\.preventDefault\(\);sendForgot\(\)"/);
const activation=readFileSync(new URL("../public/set-password.html",import.meta.url),"utf8");
assert.match(activation,/onsubmit="event\.preventDefault\(\);setPassword\(\)"/);
assert.match(activation,/async function setPassword\(\)/);
assert.doesNotMatch(activation,/async function submit\(\)/);
console.log("Password form regression checks passed");
