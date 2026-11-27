"""Run one live follow-up against a generated PDF in an isolated Chromium session."""
import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from common import PAGE_SERVER, launch_args


async def make_pdf(page):
    # Three plausible figures. Rasterize their axes so only a page image reveals the value.
    await page.set_content('<style>@page{size:600px 480px;margin:20px}section+section{break-before:page}</style>')
    await page.evaluate("""() => {
      const endpoints = {7: 20, 24: 60, 47: 40};
      for (let p = 1; p <= 47; p++) {
        const section = document.body.appendChild(document.createElement('section'));
        section.textContent = endpoints[p] ? 'Pilot response curves' : 'Pilot study notes';
        if (!endpoints[p]) continue;
        const canvas = document.createElement('canvas');
        canvas.width = 480; canvas.height = 290;
        const g = canvas.getContext('2d');
        g.fillStyle = 'white'; g.fillRect(0, 0, 480, 290);
        g.font = '18px sans-serif';
        for (let v = 0; v <= 100; v += 20) {
          const y = 230 - 2*v;
          g.fillStyle = '#111'; g.fillText(String(v), 10, y+5);
          g.fillStyle = '#ddd'; g.fillRect(55, y, 395, 1);
        }
        function line(color, ys) {
          g.strokeStyle = color; g.lineWidth = 4; g.beginPath();
          ys.forEach((v,i) => {const x=55+i*130, y=230-2*v; if(i) g.lineTo(x,y); else g.moveTo(x,y)});
          g.stroke();
        }
        line('#c22', [20,45,65,85]); line('#1464be', [10,endpoints[p]-5,endpoints[p],endpoints[p]]);
        g.fillStyle = '#111'; g.fillText('Time →', 200, 265);
        const img = new Image(); img.src = canvas.toDataURL(); section.appendChild(img);
      }
      return Promise.all([...document.images].map(img => img.decode()));
    }""")
    return await page.pdf(prefer_css_page_size=True, print_background=True)


async def main():
    job = json.load(sys.stdin)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(**launch_args())
        page = await browser.new_page(service_workers='block')
        pdf = await make_pdf(page)
        # Store documents only in this browser. Forward only explicit eval chat requests.
        await page.add_init_script("""(() => {
          const network = window.fetch.bind(window);
          window.fakeLLM = {use: async () => async () => ({text:'fixture'})};
          """ + PAGE_SERVER + """
          const local = window.fetch;
          window.fetch = (url, init) => window.liveEval && new URL(url, location.href).pathname.startsWith('/api/chat')
            ? network(url, init) : local(url, init);
        })();""")
        await page.goto(job['base'])
        await page.locator('#newDoc').click()
        await page.set_input_files('#docFile', {'name': 'Pilot report.pdf', 'mimeType': 'application/pdf', 'buffer': pdf})
        await page.locator('#docGo').click()
        await page.wait_for_function('window.__digress?.docState?.loaded')
        result = await page.evaluate("""async ({conv, tid, model}) => {
          const {buildContext} = await import('/js/context.js');
          const {serverLlm} = await import('/js/connectors.js');
          const docState = __digress.docState;
          if (docState.pages.length !== 47 || docState.pages.some(p => /\\d/.test(p)))
            throw Error('Fixture must have 47 pages with image-only numeric labels');
          conv.doc = __digress.conv.doc;
          const llm = serverLlm({llm:true, tools:true});
          const ctx = buildContext({conv, docState, prompts:PROMPTS, threadOps:ThreadOps, io:{llm}}, tid);
          const calls = [];
          const run = async (name, input) => {
            const call = {name, input}; calls.push(call);
            const res = await __digress.runDocTool(name, input, [], __digress.conv.id);
            call.result = res.error || res.parts.map(p => p.type).join('+');
            return res;
          };
          window.liveEval = true;
          const answer = await llm.complete({...ctx, model, tools:{names:ctx.tools, run},
            signal: AbortSignal.timeout(180000)});
          return {text:answer.text, model:answer.model, usage:answer.usage, calls};
        }""", job)
        print(json.dumps(result))


if __name__ == '__main__':
    asyncio.run(main())
