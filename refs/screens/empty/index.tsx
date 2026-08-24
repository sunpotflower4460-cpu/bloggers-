/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-010（空状態）
 */
const EmptyScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
    <p style={{ fontSize: 'var(--fs-3)', color: 'var(--text)', margin: 0 }}>まだ記録がありません</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
      最初の1件を追加すると、ここに表示されます
    </p>
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
      最初の記録を追加する
    </button>
  </div>
)

export default EmptyScreen
