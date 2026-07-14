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

// Khai báo biến và URL cho cơ chế Ping điều khiển từ xa
const char* pingUrl = "https://chamcong-sv-nttu.onrender.com/api/device/ping";
unsigned long lastPingTime = 0;

// Biến điều khiển màn hình không bị khóa (non-blocking)
unsigned long feedbackDisplayStartTime = 0;
bool isDisplayingFeedback = false;
const unsigned long FEEDBACK_DURATION = 2000; // Hiển thị trong 2 giây

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
  // --- PHẦN 0: QUẢN LÝ TRẠNG THÁI GIAO DIỆN VÀ PHẢN HỒI (KHÔNG KHÓA) ---
  if (isDisplayingFeedback) {
    // Tự động reset màn hình về trạng thái chờ sau 2 giây
    if (millis() - feedbackDisplayStartTime > FEEDBACK_DURATION) {
      isDisplayingFeedback = false;
      displayReady();
    }
  }

  // --- PHẦN 1: ĐỌC THẺ RFID ---
  // Chỉ quét thẻ mới khi màn hình đang ở trạng thái chờ (không hiển thị phản hồi)
  if (!isDisplayingFeedback && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
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
    
    // Đặt hẹn giờ để quay lại màn hình chờ sau 2 giây mà không khóa vòng lặp
    isDisplayingFeedback = true;
    feedbackDisplayStartTime = millis();
  }

  // --- PHẦN 2: CƠ CHẾ NHỊP TIM: Tối ưu hóa - Chống nghẽn quét thẻ ---
  if (millis() - lastPingTime > 10000) { // TĂNG LÊN 10 GIÂY (Tránh spam mạng)
      if (WiFi.status() == WL_CONNECTED) {
          WiFiClientSecure client;
          client.setInsecure(); // Bỏ qua kiểm tra SSL cho Render
          HTTPClient http;
          
          http.begin(client, pingUrl); // Dùng client bảo mật cho URL https
          
          // QUAN TRỌNG NHẤT: Chỉ đợi Server trả lời tối đa 1 giây. 
          // Quá 1 giây không thấy gì là cúp máy luôn để quay lại quét thẻ!
          http.setTimeout(1000); 
          
          int httpCode = http.GET(); // Bắt đầu gọi Sếp

          if (httpCode > 0) {
              String payload = http.getString();
              payload.trim(); 

              if (payload == "RESET") {
                  Serial.println(">>> NHAN LENH RESET TU WEB <<<");
                  lcd.clear();
                  lcd.print("Dang reset...");
                  
                  // THÊM DÒNG NÀY: Tắt WiFi cẩn thận trước khi reset để không bị đơ mạch
                  WiFi.disconnect(true); 
                  delay(500); 
                  ESP.restart(); 
              }
          } else {
              Serial.println("Ping Server that bai, bo qua de quet the...");
          }
          
          // LUÔN LUÔN KẾT THÚC KẾT NỐI ĐỂ TRÁNH TRÀN RAM (Nguyên nhân gây chết ở lần quét 3)
          http.end();
      }
      
      lastPingTime = millis(); // Đặt lại đồng hồ
  }
}

void displayReady() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("He thong D.Danh");
  lcd.setCursor(0, 1);
  lcd.print("Moi quet the...");
  // Tắt tất cả các đèn báo hiệu khi quay về màn hình chờ
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, LOW);
}

void successFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Thanh cong!     ");
  
  // Bật LED xanh và còi
  digitalWrite(LED_GREEN, HIGH); // Bật đèn
  // Dùng tone() với tham số duration để còi tự tắt, không làm khóa chương trình
  tone(BUZZER, 1200, 200); // Phát âm thanh "bíp" ở tần số 1200Hz trong 200ms
}

void errorFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Loi ket noi!    ");
  
  // Bật LED đỏ và còi
  digitalWrite(LED_RED, HIGH); // Bật đèn
  // Dùng tone() với tham số duration để còi tự tắt, không làm khóa chương trình
  tone(BUZZER, 400, 1000); // Phát âm thanh lỗi ở tần số 400Hz trong 1 giây
}