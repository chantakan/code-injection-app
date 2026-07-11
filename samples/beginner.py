# 成績の平均と判定を出す練習プログラム
scores = [72, 85, 91, 58, 66, 79]

total = 0
for s in scores:
    total = total + s

average = total / len(scores)
print("平均点:", average)

if average >= 80:
    print("よくできました")
elif average >= 60:
    print("まずまずです")
else:
    print("がんばりましょう")

high = []
for s in scores:
    if s >= 80:
        high.append(s)

print("80点以上:", high)
print("最高点:", max(scores))
print("最低点:", min(scores))