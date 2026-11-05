# IM 正文协议 v2.1

使用 JSON，不写伪工具调用。基础键为 v:2、kind、task、summary。task 仅在确实没有关联任务时为 null；只要知道 Issue ID，就使用 {id,owner,version,code_ref?}，其中未知或当前无法读取的 owner/version 明确写 null，说明不可读取的原因，不借旧事实补全。收到消息者按自己权限回读后再行动。写你确实观察到的事实，未知不编造。owner/version 只是观察值，不是 CAS 或授权。工具参数中的真实收发身份和 reply 关联仍为权威。

request_ref 的类型固定为字符串或 null：消息引用用 "threadId/messageId"；派发通知引用用 "notice:实际noticeId"；没有可引用的请求用 null，不造 ID、不传对象。kind 固定取下面六种值。

按消息类型补充内容：
- request：need:{deliverable,scope,feedback}；refs 指向最小输入。
- accept：request_ref（原 thread/message 或派发引用）、next（首步和反馈触发条件）。
- blocked：request_ref、blocker、tried、recommendation、next。一次回复已能说明阻塞时不先发 accept。
- result：request_ref、artifacts、evidence（适用版本、已做/未做/不确定）、next。
- decision：request_ref、decision、basis、next；只能作权限内裁定，不代替正式改派或用户验收。
- info：refs 与必要 next；默认无需回复。

字段按需简短填写，数组可为空，但不能拿空 evidence 假装验证通过。JSON 正文引用不能替代 company_im.reply 的 threadId/messageId。多条消息同任务也用原请求关联，迟到结果先对照当前 owner、范围和产物版本。

示例 request：
```json
{"v":2,"kind":"request","task":{"id":"I-214","owner":"dev","version":8,"code_ref":"c-new"},"summary":"请确认缓存失效边界","need":{"deliverable":"对失败路径的定位与最小复验建议","scope":"仅缓存失效，不改任务状态","feedback":"给出结论或发现输入缺口时"},"refs":["I-214","reports/cache-failure.md"]}
```

示例 blocked：
```json
{"v":2,"kind":"blocked","task":{"id":"I-214","owner":"dev","version":8,"code_ref":"c-new"},"summary":"现有报告只覆盖c-old","request_ref":"T2/M2","blocker":"缺少c-new的失效用例结果","tried":["核对报告代码版本"],"recommendation":"由持有c-new工作区的dev补这一项检查","next":"等待补充结果；我不重复运行旧检查"}
```

传输参数示例：ask({toAgentId:"peer",text:JSON.stringify(message),requestId:"I214-cache-query-1"})；回复使用 reply({threadId:"T2",messageId:"M2",text:JSON.stringify(response),requestId:"I214-cache-result-1"})。例中 ID 仅示意，实际必须取真实对象。
