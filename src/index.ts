import fetch from "node-fetch";
import {readFile, writeFile} from 'fs/promises';
import {OpenAI} from 'openai';
import llama3Tokenizer from 'llama3-tokenizer-js'

const openai = new OpenAI({
  baseURL: 'http://localhost:4891/v1'
});
const MODEL = "Llama 3 8B Instruct";
const MAX_CONTEXT_SZ = 2048;

const access_token = process.env.ACCESS_TOKEN;

async function getLlmResponse(user: string) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: user
    }],
  });
  return response.choices[0].message;
}

let summary: string;
let lastModifiedDateTime: string;

try {
  const stateText:string = await readFile('./state.json', 'UTF-8') as string;
  const parsed = JSON.parse(stateText);
  summary = parsed.summary;
  lastModifiedDateTime = parsed.lastModifiedDateTime;
} catch (e) {
  if (e.code === 'ENOENT') {
    summary = '';
  } else {
    console.error(e);
    process.exit(-1);
  }
}

function formUserPrompt(messageText: string) {
  if (summary.length) {
    return `Please read the (1) summary ("SUMMARY") of previous dialog, and (2) following dialog ("DIALOG") and list the main topics succinctly.
Are there any outstanding issues? Is everyone agreeing? Does anyone have outstanding tasks?
People are tagged by the use of the <at> HTML element.
  
SUMMARY
${summary}

DIALOG
${messageText}
`;
  } else {
    return `Please read the following dialog and list the main topics succinctly.
Are there any outstanding issues? Is everyone agreeing? Does anyone have outstanding tasks?
People are tagged by the use of the <at> HTML element.

${messageText}`;
  }
}


const chat_id = process.env.CHAT_ID;
const parameters = lastModifiedDateTime.length ? `$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20${lastModifiedDateTime}` : '';
let response = await fetch(`https://graph.microsoft.com/beta/chats/${chat_id}/messages?${parameters}`,{
  method: 'GET',
  headers: {
    Authorization: `Bearer ${access_token}`,
  }
});

const promptSizeWithoutDialog = llama3Tokenizer.encode(formUserPrompt('')).length;
let remainingContextSz = MAX_CONTEXT_SZ - promptSizeWithoutDialog;
console.log(`Prompt size without dialog is ${promptSizeWithoutDialog}, available size for dialog is ${remainingContextSz}`);

const jsonRetrieved = await response.json();
if(jsonRetrieved.error) {
  console.error(jsonRetrieved.error);
  process.exit(-1);
}
console.log(`Retrieved ${jsonRetrieved.value.length} new messages`);

if(jsonRetrieved.value.length === 0) {
  console.log('Nothing to do');
}

lastModifiedDateTime = jsonRetrieved.value[0].lastModifiedDateTime;

const messagesLastFirst = [...jsonRetrieved.value];
const messagesToProcessLastFirst = [];
for (let i = 0; i < messagesLastFirst.length; i++){
  const m = messagesLastFirst[i];
  const length = llama3Tokenizer.encode(m.body.content).length;
  if(length < remainingContextSz) {
    messagesToProcessLastFirst.push(m);
    remainingContextSz -= length;
  } else {
    break;
  }
}

console.log(`Will use ${messagesToProcessLastFirst.length} new messages`);

const messages = messagesToProcessLastFirst.reverse();
let texts = messages.map(m => `${m.from.user.displayName}: ${m.body.content}`);
const messageText = texts.join('\n\n');


let userPrompt = formUserPrompt(messageText);

console.log(userPrompt);

const completionMessage = await getLlmResponse(userPrompt);
console.log(completionMessage.content);

await writeFile('./state.json', JSON.stringify({
  summary,
  lastModifiedDateTime,
}));
