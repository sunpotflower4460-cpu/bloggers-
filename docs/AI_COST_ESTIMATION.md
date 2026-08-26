# AI Cost Estimation

Blog GardenのF-032は、AI providerの価格をコードへ決め打ちせず、**運用者が確認した単価**と実際にproviderが返したtoken usageから参考コストを計算します。

これは請求システムではありません。providerの価格改定、cache/read/write token、reasoning token、batch割引、契約割引、税、為替などをBlog Gardenが推測しないため、表示額は**運用判断用の推定値**です。

## 設定

```env
AI_PRICE_CURRENCY=USD
AI_PRICE_TABLE_JSON={"primary:your-model":{"inputPerMillion":1.00,"outputPerMillion":4.00},"economy:your-economy-model":{"inputPerMillion":0.20,"outputPerMillion":0.80}}
```

`AI_PRICE_TABLE_JSON`のキーは、実行時に保存される次の完全一致文字列です。

```text
providerLabel:model
```

例:

- `primary:gpt-example`
- `fallback:model-example`
- `economy:model-example`

同じmodel名でもprovider labelが違えば別単価として扱えます。

値はすべて`AI_PRICE_CURRENCY`で指定した同一通貨の**100万tokenあたりの単価**です。

- `inputPerMillion`
- `outputPerMillion`

Blog Gardenはproviderの現在価格を自動取得しません。価格改定時は運用者がこの表を更新してください。

## 保存するusage

各外向きAI requestは既存の日次call予算に加えて、`providerLabel:model`単位でも日次集計されます。

保存項目:

- calls
- metered calls
- input tokens
- output tokens
- total tokens

`metered_calls`を別に持つため、同じmodelでusageを返したcallと返さなかったcallが混在しても、未計測callを見失いません。

既存DBへ`metered_calls`を追加するmigrationでは、過去行を「全部usage取得済み」と推測して埋めません。分からない履歴は不明のまま残す方針です。

providerが返すusageは外部入力として扱います。非有限値・負数は記録せず、異常に大きい有限値は1フィールド10億tokenで上限をかけてからSQLiteへ保存します。

## `/diagnostics` の表示

`AI_PRICE_TABLE_JSON`を設定すると、健康診断に次を表示します。

- 今日の推定額
- 直近7日の推定額
- 観測日の平均から計算した30日換算
- token価格カバレッジ
- 単価未設定model
- 推定対象外token
- providerがtoken usageを返さなかったcall数
- model別の推定額上位

単価表が未設定の場合もmodel別usageは保存しますが、Blog Gardenは価格を勝手に補完せず、金額推定を行いません。

## カバレッジ

推定に使用できるのは、次の両方を満たすtokenだけです。

1. providerが`input_tokens` / `output_tokens`を報告した
2. その`providerLabel:model`に単価が設定されている

次は推定額へ含めません。

- 単価未設定modelのtoken
- usageを返さなかったcall
- `total_tokens`には含まれるがinput/outputへ分類されていない追加token category

これらが1つでもある場合、診断は完全な見積もりとして扱わずwarningにします。0円として隠すことはありません。

## 30日換算

30日換算は直近7日間のうち、実際にcallまたはtoken usageが存在した**観測日**の平均推定額を30倍したものです。

そのため、まだ1日しか運用していない場合は1日分を30倍した粗い参考値です。長期契約額やprovider請求額を保証する値ではありません。

## F-034: 推定コストwarning閾値

F-034では、運用者が任意で「ここを超えたら気づきたい」という参考warning閾値を設定できます。

```env
AI_ESTIMATED_DAILY_COST_WARN=5
AI_ESTIMATED_30D_COST_WARN=100
```

単位は`AI_PRICE_CURRENCY`です。どちらか片方だけでも設定できます。未設定なら閾値監視は無効です。

この閾値は**請求上限でもhard stopでもありません**。超過すると`ai-estimated-cost-threshold` warning incidentをOPENし、既存Webhook通知の対象になりますが、Blog GardenはAI call停止・provider変更・economy切替・公開方針変更を自動では行いません。

### 保守的な判定

coverageが不完全でも、価格を付けられた観測済み部分だけで閾値以上なら確実なwarningとして通知します。

一方、観測済み推定額が閾値未満でもcoverage不足なら「実コストも閾値未満」とは判断できません。そのため:

- incidentがまだ無い場合: `/diagnostics`ではwarning表示し、安全とは宣言しない
- すでに閾値超過incidentがOPENの場合: coverageが不完全なまま推定額だけ下がっても**CLOSEDにしない**
- 全model価格・usage coverageが完全になり、その状態で閾値未満になった時だけ復旧としてCLOSED

これにより、providerがusageを返さなくなっただけで「コストが下がった」と誤認する事故を防ぎます。

### 閾値の無効化

運用者が両方の閾値を削除した場合は監視を明示的に無効化したものとして、既存の閾値incidentをCLOSEDにします。この場合のdetailには「コスト低下を確認したわけではない」ことを残します。

## F-035: ブログ別AI使用量・推定コスト帰属

複数ブログを自律運用すると、全体金額だけでは「どの庭が費用を使っているか」が分かりません。F-035では各ブログ実行をNode.jsの`AsyncLocalStorage` scopeで包み、実際のAI outbound callを次のscopeへ同時集計します。

```text
blog:<blog-id>
system/unattributed
```

ブログscopeには表示用としてその時点のブログ名も保存します。ブログ外で実行されたAI callを最も近いブログへ推測配分することはせず、必ず`system/unattributed`として明示します。

保存は`scope + model + day`単位なので、同じブログ内でもprimary / fallback / economyの各model単価を正しく使って推定できます。

`/diagnostics`の`AIブログ別帰属`では次を表示します。

- scope別の直近7日calls
- scope別の直近7日推定額（単価表がある場合）
- scope別token価格coverage
- calls / tokens の帰属coverage
- F-035導入前など、全体usageには存在するがscope履歴が無い帰属不能calls/tokens

### 並列実行での分離

単純なprocess-global変数ではなく`AsyncLocalStorage.run()`を使うため、将来複数ブログを同時実行しても、各非同期処理は自分のブログscopeを保持します。F-035のCIでは意図的に複数scopeを並列・交互実行して混線しないことを確認します。

### 過去履歴を逆算しない

F-035より前のmodel別usageにはブログ情報がありません。その履歴を投稿数やブログ比率から推測して各ブログへ配ると、正確に見えて実際は捏造された内訳になります。

そのため過去の未帰属usageはそのまま`帰属不能`として残し、calls/tokenの帰属coverageを100%未満で表示します。F-035以降の新しいcallが蓄積するにつれて直近7日の帰属coverageは自然に100%へ近づきます。

## F-036: ブログ別AI費用・成果観測パネル

F-036はトップ画面で、ブログ別のAI費用と最近の成果シグナルを**横並びで観測**できるようにします。

表示する主な値:

- AI推定費用: 現在までの直近7日
- AI calls: 現在までの直近7日
- 新規記事数: 現在までの直近7日
- GA4 PV / sessions / engagement: 直近7日
- native comments: 各記事の最新取得値の合計
- Search Console: 最新の確定7日窓

### Search Console窓を混ぜない

Search Consoleはfinal dataの遅延を考慮して、通常は**9日前〜3日前**の7日窓を取得します。

従来の単純な「各記事の最新snapshot」合算では、ある記事だけ取得が古い場合に異なる7日窓を混ぜる可能性がありました。F-036ではブログ内の最新`snapshot_date`を先に1つ決め、その日付と完全一致するSearch Console snapshotだけを合算します。

これにより、たとえば最新窓のデータと前回窓のデータが同じブログ内で足し合わされることを防ぎます。

### ROIやCPCを出さない理由

AI費用は「今日までの直近7日」ですが、Search Consoleはデータ確定待ちのため「3日前で終わる7日窓」です。記事が公開されてから検索流入へ反映される時間差もあります。

そのためBlog Gardenは次のような比率を自動生成しません。

- ROI
- cost per click
- cost per view
- efficiency score
- 「このブログは費用対効果が悪い」という自動判定

数値を同じ画面で見る目的は、人間が「この庭は費用が増えているのに成果シグナルがまだ弱いかもしれない」「この庭は少ないAI callでも反応が育っているかもしれない」と**仮説を持つため**です。因果関係や投資収益を証明するものではありません。

### 設定エラーを画面全体へ波及させない

価格表が壊れている場合、トップ画面はクラッシュせず、費用欄を設定エラー/金額未推定として表示します。投稿・PV・検索など他の成果シグナルは引き続き確認できます。

## F-037: ブログ別AI運用観測フラグ

F-037はF-036のカードに、**人間が確認するとよい運用上の事実**だけを追加表示します。これはランキング、品質評価、ROI判定ではありません。

現在の保守的ルール:

- `cost-coverage-gap`: AI callがあるのに、そのブログの価格/token usage coverageが完全ではない
- `calls-without-publication`: 直近7日でAI callが4回以上あるが、新規publicationが0
- `high-call-density`: 新規publicationがあり、直近7日AI callが12回以上かつpublicationあたり6 calls以上
- `outcome-data-sparse`: AI callが3回以上あるが、GA4 PV/sessions・native comments・確定Search Consoleの観測値がまだ無い
- `recent-run-errors`: 直近7日のrun logに2件以上のerrorがある

### 閾値を保守的にする理由

新規記事の通常フローでも、内部企画と最終生成で複数AI callを使います。さらにfallback救済、headline refresh、draft、人間操作などでcall数は増えます。

そのため、`high-call-density`は単純な「2 calls/articleを超えたら異常」にはしていません。**12 calls以上かつ6 calls/publication以上**という絶対値と比率の両方を満たす時だけ、「内訳を確認するとよい」という参考フラグにします。

`calls-without-publication`も「失敗」とは断定しません。refresh・draft・企画・失敗後の回復など正当な理由があり得るため、run logを確認する入口に留めます。

`outcome-data-sparse`は特に新規ブログや連携直後では正常です。「成果が悪い」ではなく**まだ測定材料が足りない**という意味しか持ちません。

### フラグが0件でも安全保証ではない

カードに追加フラグが無い場合も「問題なし」「高効率」という意味ではありません。現在の保守的な決め打ちルールで、機械的に目立たせられる観測事項が無いだけです。

### 自動制御には使わない

F-037のフラグは次へ接続しません。

- ブログ停止/再開
- primary / fallback / economyのroute変更
- publish mode変更
- AI budget変更
- 記事削除や既存記事更新
- provider/modelの品質ランク付け

フラグは人間の調査対象を絞るための表示情報です。

## 安全境界

F-032/F-034/F-035/F-036/F-037は可視化・警告・帰属・観測機能です。推定コストや成果の見え方を理由に、Blog Gardenが自動で次を変更することはありません。

- primary / fallback provider
- `AI_INTERNAL_ROUTE_POLICY`
- `AI_FALLBACK_CONTENT_POLICY`
- 日次call/token上限
- auto / review公開方針
- ブログの停止/再開

route・公開権限・停止判断は引き続き人間の明示設定です。
