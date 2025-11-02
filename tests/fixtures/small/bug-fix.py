# Small file: bug fix - off-by-one error
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n+1)

print(fibonacci(5))
