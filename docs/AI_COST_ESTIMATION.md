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

## 安全境界

F-032は可視化機能です。推定コストが高い・低いことを理由に、Blog Gardenが自動で次を変更することはありません。

- primary / fallback provider
- `AI_INTERNAL_ROUTE_POLICY`
- `AI_FALLBACK_CONTENT_POLICY`
- 日次call/token上限
- auto / review公開方針

routeや公開権限の変更は引き続き人間の明示設定です。
