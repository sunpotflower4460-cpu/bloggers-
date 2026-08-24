/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-011（空状態：検索結果ゼロ）
 */
const EmptySearchScreen = () => {
  const query = '在庫切れ'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
      <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>
        「{query}」に一致する結果がありません
      </p>
      <button
        style={{
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--fs-2)',
          color: 'var(--accent)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-s)',
        }}
      >
        検索条件をリセット
      </button>
    </div>
  )
}

export default EmptySearchScreen
