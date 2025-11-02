# Medium file: with duplicate code blocks - tests uniqueness
def validate_email(email: str) -> bool:
    if not email or len(email) == 0:
        return False
    if '@' not in email:
        return False
    return True

def validate_phone(phone: str) -> bool:
    if not phone or len(phone) == 0:
        return False
    if '@' not in phone:
        return False
    return True

def validate_username(username: str) -> bool:
    if not username or len(username) == 0:
        return False
    if '@' not in username:
        return False
    return True

def process_contact(email, phone, username):
    email_valid = validate_email(email)
    phone_valid = validate_phone(phone)
    username_valid = validate_username(username)
    return email_valid and phone_valid and username_valid
