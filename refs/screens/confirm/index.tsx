/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-016（取り消せない操作をさせる）
 */
const ConfirmScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>
      この記録を削除します。削除すると元に戻せません
    </p>
    <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
      <button
        style={{
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--fs-2)',
          color: 'var(--text)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-s)',
        }}
      >
        やめる
      </button>
      <button
        style={{
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--fs-2)',
          color: 'var(--text)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-s)',
        }}
      >
        削除する
      </button>
    </div>
  </div>
)

export default ConfirmScreen
