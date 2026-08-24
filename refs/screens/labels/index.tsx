/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-040（ボタンのラベルを決める）
 * 語彙は craft/vocabulary/labels.md の対応表から選ぶ
 */
const LabelsScreen = () => (
  <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
    <button
      style={{
        padding: 'var(--sp-2) var(--sp-3)',
        fontSize: 'var(--fs-2)',
        color: 'var(--bg)',
        background: 'var(--accent)',
        border: 'none',
        borderRadius: 'var(--radius-s)',
      }}
    >
      保存する
    </button>
    <button
      style={{
        padding: 'var(--sp-2) var(--sp-3)',
        fontSize: 'var(--fs-2)',
        color: 'var(--text-muted)',
        background: 'transparent',
        border: 'none',
      }}
    >
      やめる
    </button>
  </div>
)

export default LabelsScreen
