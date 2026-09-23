"""Original typography/architecture illustrations; no external artwork."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT=Path(__file__).resolve().parents[1]/'docs/images'
OUT.mkdir(exist_ok=True)
FONT='/System/Library/Fonts/PingFang.ttc'
BG='#F5F5ED'; INK='#183E34'; GREEN='#235C48'; LIME='#D3E8AA'; MUTED='#657669'
def font(n): return ImageFont.truetype(FONT,n)
def canvas(w,h):
    im=Image.new('RGB',(w,h),BG); return im,ImageDraw.Draw(im)
def text(d,xy,s,size=30,fill=INK): d.text(xy,s,font=font(size),fill=fill)
def card(d,box): d.rounded_rectangle(box,radius=24,fill='#FFFFFF',outline='#D7DFCF',width=2)
def save(im,name): im.save(OUT/name,optimize=True)

im,d=canvas(1600,900)
d.rectangle((0,0,1600,20),fill=GREEN)
text(d,(90,65),'JEV EVERYDAY KIT   /   BUILD LOG 01',25,MUTED)
text(d,(85,165),'我用 Jev 做了',94)
text(d,(85,290),'三个日常效率工具',94)
text(d,(93,440),'让模型做小判断，让程序检查并执行。',34,MUTED)
for x,num,title,desc in [(90,'01','标签页整理','Chrome / Edge'),(575,'02','飞书反馈分诊','审阅 · 回填 · 撤销'),(1060,'03','GitHub 工具箱','分类 · 搜索 · 导出')]:
    card(d,(x,575,x+450,785)); text(d,(x+28,592),num,27,GREEN);text(d,(x+28,637),title,39);text(d,(x+28,708),desc,25,MUTED)
text(d,(92,833),'3 TOOLS  /  1 LOCAL WORKBENCH  /  TYPESCRIPT',23,MUTED)
save(im,'cover.png')

im,d=canvas(1600,950)
text(d,(70,55),'一条共同的处理链',62)
text(d,(73,145),'模型给出建议，程序检查条件，用户保留决定权。',29,MUTED)
steps=[('01  平台输入','标题与域名 / 反馈文本 / 仓库元数据'),('02  Jev Choice','固定候选项 + 结构化分类结果'),('03  校验与审阅','类型检查 · 阈值分流 · 人工修正'),('04  有限执行','原生分组 / 确认回填 / 本地导出')]
for i,(title,desc) in enumerate(steps):
 y=230+i*154;card(d,(75,y,1525,y+122));text(d,(105,y+22),title,33);text(d,(570,y+30),desc,29,MUTED)
 if i<3:text(d,(770,y+120),'↓',26,GREEN)
text(d,(78,877),'低把握 → 待确认     ｜     数据变化 → 停止旧计划     ｜     完成操作 → 保存回执',25,GREEN)
save(im,'architecture.png')

im,d=canvas(1600,950)
text(d,(70,55),'飞书回填：先计划，再执行',60)
text(d,(73,145),'一条反馈的处理过程',30,MUTED)
rows=[('读取','筛选待处理记录，记录输入哈希'),('审阅','修正类别和优先级，排除不处理的记录'),('回填','重新读取，检查输入变化及人工编辑'),('回执','保存本次成功写入与原值，支持失败重试'),('撤销','核对当前值，只撤销仍属于本次写入的内容')]
for i,(t,b) in enumerate(rows):
 y=230+i*120;card(d,(75,y,1525,y+95));text(d,(110,y+20),t,34);text(d,(330,y+24),b,30,MUTED)
text(d,(80,875),'设计目标：不把“模型认为可以”直接变成“已经修改数据”。',28,GREEN)
save(im,'feishu-flow.png')

im,d=canvas(1600,950)
text(d,(70,55),'Star Atlas：减少重复判断',60)
text(d,(73,145),'缓存模型建议，同时保留人的修正',30,MUTED)
for y,t,b in [(250,'分类依据变了','模型 / 分类方案 / 名称 / 简介 / topics / 语言 → 重新判断'),(425,'只有 Star 数变了','更新仓库信息，复用已保存的分类结果'),(600,'用户已经修正','人工分类和备注优先保留；演示数据与真实缓存隔离')]:
 card(d,(75,y,1525,y+135));text(d,(110,y+16),t,34);text(d,(110,y+76),b,28,MUTED)
text(d,(80,857),'结果可导出：Markdown  /  JSON  /  自包含离线 HTML',30,GREEN)
save(im,'cache.png')

cards=[('我用 Jev 做了','3 个效率工具','标签页整理 / 飞书分诊 / GitHub 收藏','01  标签页，整理成原生分组\n02  飞书反馈，审阅后再回填\n03  GitHub 收藏，变成工具箱'),('01 / TAB SORT','标签页，各归其位','先预览，再创建原生分组','搜索与手动分类\n取消后继续分析\n支持撤销，不关闭页面'),('02 / FEISHU','让反馈有下一步','类别和优先级，分开判断','审阅计划，确认后回填\n输入变化时停止旧计划\n回执、重试与冲突检查撤销'),('03 / STAR ATLAS','收藏变成工具箱','用途 + 产品形态，两条线整理','搜索筛选，人工修正\n增量缓存，减少重复判断\n导出 Markdown / JSON / 离线网页'),('HOW IT WORKS','模型判断，程序执行','固定类别 → 结构校验 → 人工审阅','默认 75% 是产品阈值\n不等于实测准确率\n不确定的内容保留待确认'),('LOCAL FIRST','本地工作台','三个工具，一个入口','任务历史保存在本机\n凭据只保留在服务内存\n真实模式会调用对应官方 API'),('VERIFICATION','把验证边界讲清楚','34 项单元/集成 + 9 项端到端测试','本地复测共 43 项通过\n图中使用演示或测试样例\n真实账号效果仍需配置后验证'),('GET STARTED','先试离线样例','无需密钥，先看操作流程','源码与详细安装说明已整理\n想获取项目，可私信关键词 jev\n个人原创，转载请注明出处')]
for i,(eyebrow,title,sub,body) in enumerate(cards):
 im,d=canvas(1080,1440);d.rectangle((0,0,1080,18),fill=GREEN)
 text(d,(70,85),'JEV / EVERYDAY TOOLS',27,MUTED)
 text(d,(70,220),eyebrow,38,GREEN)
 # use two lines for long titles
 if len(title)>9: text(d,(65,345),title[:8],70);text(d,(65,450),title[8:],70); sy=630
 else:text(d,(65,350),title,76);sy=555
 text(d,(72,sy),sub,33,MUTED)
 card(d,(65,sy+105,1015,1230))
 for j,line in enumerate(body.split('\n')): text(d,(102,sy+165+j*100),line,35)
 text(d,(75,1325),f'JEV EVERYDAY KIT  ·  {i+1:02d} / 08',25,MUTED)
 save(im,f'xiaohongshu-{i+1:02d}.png')
