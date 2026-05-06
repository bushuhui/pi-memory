
## LanceDB 优化

LanceDB 数据量达到 5-6GB 后插入变慢，最常见的原因是**数据碎片化**和**版本累积**。LanceDB 每次写入会创建新的数据片段（fragment），频繁插入会产生大量小文件，导致元数据膨胀和写入效率下降。

以下是针对你场景的优化方案，按优先级排序：

---

### 1. 立即执行：定期运行 `optimize()`（最关键）

LanceDB 提供类似 PostgreSQL `VACUUM` 的 `optimize()` 命令，用于合并小文件、清理旧版本、更新索引。数据量大后必须定期执行：

```python
import datetime

# 合并小文件 + 清理旧版本（保留最近1天的版本）
table.optimize(
    cleanup_older_than=datetime.timedelta(days=1),
    delete_unverified=False
)
```

- **Compaction**：合并磁盘上的小片段，减少碎片化 
- **Prune**：删除旧版本数据集，降低元数据开销 
- **Index**：将新数据合并到现有索引中 

> 经验法则：尽量将数据集控制在 **100 个左右的片段** 以内（直到达到 10 亿行级别）

---

### 2. 写入方式优化：严格使用批量插入

**绝对避免逐行插入**。每次单行插入都会在磁盘上创建一个新的数据片段，导致严重的碎片化：

```python
# ❌ 错误：逐行插入，产生大量碎片
for item in data:
    table.add([item])

# ✅ 正确：一次性批量插入（推荐）
table.add(large_dataframe)  # Pandas DataFrame 或 PyArrow Table

# ✅ 或者：使用 PyArrow Dataset 流式读取大文件
import pyarrow.dataset as ds
dataset = ds.dataset("path/to/data/", format="parquet")
table.add(dataset)
```

官方建议：使用 `pa.Table`、`pd.DataFrame` 或 `pa.dataset()` 进行批量写入，LanceDB 会自动并行化，按约 **100 万行或 2GB** 自动分区 。

---

### 3. 建表策略：先创建空表，再批量 add

如果当前是通过 `create_table(data=...)` 一次性建表，建议改为**先创建空表，再调用 `table.add()`**：

```python
# ✅ 推荐：先创建空表，再 add（支持自动写入并行化）
table = db.create_table("my_table", schema=schema)  # 不带数据
table.add(large_dataframe)
```

`create_table()` 直接传数据不会启用自动并行写入，而 `table.add()` 会 。

---

### 4. 控制版本数量

LanceDB 每次插入都会生成一个新版本。版本过多会导致元数据开销显著增加（100 个版本 ≈ 100 倍元数据开销）。建议：

- 在写入任务结束后，定期调用 `optimize()` 清理旧版本
- 如果不需要版本历史，可以设置 `cleanup_older_than=timedelta(0)` 只保留最新版本（需谨慎，确保无其他进程正在访问该表）

---

### 5. 索引相关优化

如果表上建有 ANN 索引（IVF_PQ / HNSW），插入新数据后索引不会自动包含新数据，需要优化：

- 新数据默认可通过暴力搜索（kNN）查询，但延迟较高
- 运行 `table.optimize()` 会将新数据合并到现有索引 
- 如果数据频繁更新，考虑**延迟建索引**：先批量导入所有数据，最后统一创建索引，避免边写边重建索引的开销

---

### 6. 针对对象存储的额外优化（如使用 S3/Azure Blob）

如果数据存储在对象存储上，网络延迟会显著影响插入性能 ：

- **增加 IO 线程数**：设置环境变量 `LANCE_IO_THREADS`（默认通常较低，可适当提高）
- **调整 `io_buffer_size`**：提高单次请求的数据量
- **复用 Table 实例**：将 table 对象缓存到内存中，避免重复加载元数据和索引 

---

### 7. 监控诊断：查看当前片段数量

先诊断当前表的碎片化程度：

```python
# 查看当前有多少个数据片段
fragments = table.to_lance().get_fragments()
print(f"当前片段数: {len(fragments)}")

# 查看查询执行计划，定位瓶颈
table.search([...]).explain_plan()
table.search([...]).analyze_plan()
```

如果片段数远超 100，说明碎片化是主要问题，`optimize()` 后会有明显改善 。

---

### 总结建议

| 优先级 | 措施 | 预期效果 |
|--------|------|----------|
| 🔴 高 | 立即执行 `table.optimize()` 合并碎片 | 显著降低后续写入和查询延迟 |
| 🔴 高 | 改为批量插入（DataFrame/Arrow Table） | 减少新碎片产生 |
| 🟡 中 | 先 `create_table(schema=...)` 再 `table.add()` | 启用自动并行写入 |
| 🟡 中 | 定期清理旧版本（如每天一次） | 降低元数据开销 |
| 🟢 低 | 调整 IO 线程数（对象存储场景） | 提升吞吐 |

如果执行 `optimize()` 后插入仍然慢，请检查：
1. 是否还是逐行/小批量插入？
2. 是否每次插入后都立即查询（可能触发了索引更新）？
3. 存储是本地磁盘还是远程对象存储？