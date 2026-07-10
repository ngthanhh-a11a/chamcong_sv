#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h> 
#include <WiFiClientSecure.h> // SỬA LỖI: Bắt buộc phải có để chạy HTTPS đám mây
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// SỬA LỖI: Thêm chính xác phân hệ API endpoint ở cuối đường dẫn
const char* serverName = "https://chamcong-sv-nttu.onrender.com/api/attendance";

// Định nghĩa chân kết nối (Giữ nguyên cấu hình phần cứng cũ)
#define SS_PIN 5
#define RST_PIN 4
#define LED_GREEN 12
#define LED_RED 14
#define BUZZER 13

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);

void displayReady();
void successFeedback();
void errorFeedback();

void setup() {
  Serial.begin(115200);
  
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, LOW);
  digitalWrite(BUZZER, LOW);

  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Dang ket noi WiFi...");

  SPI.begin();
  rfid.PCD_Init();

  // Kết nối WiFi Wokwi
  WiFi.begin("Wokwi-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  // Đã chuyển đổi sang giao thức bảo mật đám mây thành công
  Serial.println("\n[Thành công] Đã kết nối WiFi Internet.");
  displayReady();
}

void loop() {
  // Đọc thẻ RFID
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial())
    return;

  String uidStr = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    uidStr += String(rfid.uid.uidByte[i] < 0x10 ? "0" : "");
    uidStr += String(rfid.uid.uidByte[i], HEX);
  }
  uidStr.toUpperCase();
  
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("UID: " + uidStr);
  lcd.setCursor(0, 1);
  lcd.print("Dang gui API...");
  Serial.println("\nQuét được thẻ UID: " + uidStr);

  // Gửi HTTP POST lên Server Render Cloud
  if (WiFi.status() == WL_CONNECTED) {
    // SỬA LỖI: Tạo client bảo mật và cấu hình bỏ qua kiểm tra chứng chỉ SSL của Render
    WiFiClientSecure client;
    client.setInsecure(); 

    HTTPClient http;
    http.begin(client, serverName); // Khởi tạo kết nối bảo mật HTTPS
    
    // Khai báo Header là JSON
    http.addHeader("Content-Type", "application/json");

    // Tạo chuỗi JSON thủ công cực nhẹ: {"uid":"E3F2A1B2"}
    String httpRequestData = "{\"uid\":\"" + uidStr + "\"}";
    
    // Gửi request POST
    int httpResponseCode = http.POST(httpRequestData);
    
    // SQA Logic: Chấp nhận mã 200 (OK) hoặc 201 (Created) từ Node.js Backend
    if (httpResponseCode == 200 || httpResponseCode == 201) {
      Serial.print("Đẩy dữ liệu thành công. HTTP Code: ");
      Serial.println(httpResponseCode);
      successFeedback();
    } else {
      Serial.print("Lỗi từ Server. HTTP Code: ");
      Serial.println(httpResponseCode);
      errorFeedback();
    }
    
    http.end(); // Giải phóng tài nguyên mạng
  } else {
    Serial.println("Lỗi mất kết nối WiFi");
    errorFeedback();
  }
  
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  
  delay(2000); 
  displayReady(); 
}

void displayReady() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("He thong D.Danh");
  lcd.setCursor(0, 1);
  lcd.print("Moi quet the...");
}

void successFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Thanh cong!     ");
  
  // Bật LED xanh và phát âm thanh tần số 1000Hz
  digitalWrite(LED_GREEN, HIGH);
  tone(BUZZER, 1000); 
  
  delay(500); // Kéo dài thời gian sáng đèn để dễ quan sát
  
  // Tắt LED và ngắt âm thanh
  noTone(BUZZER);
  digitalWrite(LED_GREEN, LOW);
}

void errorFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Loi ket noi!    ");
  
  // Bật LED đỏ và còi kêu dài cảnh báo
  digitalWrite(LED_RED, HIGH);
  digitalWrite(BUZZER, HIGH); 
  delay(1000); 
  
  digitalWrite(BUZZER, LOW);
  digitalWrite(LED_RED, LOW);
}